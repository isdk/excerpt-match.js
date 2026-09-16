/**
 * 定位器 —— 只做确定性的 T0/T1/T2，T3/T4 委托给注入的 fallback。
 *
 * 自己写的只有三件事，其余全部交给现成库：
 *   1. 归一化 + 下标映射（无库可替）
 *   2. 归一化空间 → 原文坐标的回切（无库可替）
 *   3. 分层编排与门限（业务语义）
 */

import type {
  Candidate, ExcerptMatch, FallbackMatcher, FlatBlock, FlatResult, MatchContext,
  MatchOptions, NormalizedText,
} from './types';
import { NO_MATCH } from './types';
import { normalizeWithMap, snapToGraphemeBoundary } from '@isdk/normalize-text';
import type { NormalizeOptions } from '@isdk/normalize-text';
import { trimMarkdownEdges, expandToInlineMarkers, deriveJoined } from '@isdk/md-flatten';
import { detectLanguageProfile, languageProfileFor, tokenize, type LanguageProfile } from './languageProfiles';
import { withPreset } from './presets';
import type { MarkdownFlattener } from './types';
import { DEFAULT_ELLIPSIS, type EllipsisPattern } from './types';
import type { ParticleTagger } from '@isdk/zh-particles';
import { detectNegation, negationsConflict } from '@isdk/zh-negation';
import type { NegationLexicon } from '@isdk/zh-negation';
import type { ChineseNumeralParser } from '@isdk/normalize-text';

/** 无模式时返回永不匹配的正则 —— 空数组即关闭 T2，而不是退化成「处处可切」 */
const NEVER_RE = /(?!)/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把多个省略号模式合并成一个正则。
 *
 * 带 g 的用于 split，不带 g 的用于探测 —— 两者必须分开构造，
 * 否则 test() 的 lastIndex 会在多次调用间残留，导致隔一次才命中。
 *
 * **关键**：切分发生在归一化**之后**，所以字符串模式必须先过一遍同样的归一化。
 * 否则用户写的 `〔中略〕` 匹配不到归一化后的 `[中略]`（NFKC 把全角括号折成了半角）。
 * 正则模式则原样使用 —— 它本来就作用在归一化后的文本上。
 *
 * @param norm 与页面/摘录相同的归一化函数
 */
function buildEllipsisRe(
  patterns: readonly EllipsisPattern[],
  flags: string,
  norm: (s: string) => string
): RegExp {
  if (patterns.length === 0) return NEVER_RE;
  const parts = patterns
    .map((p) => {
      if (typeof p !== 'string') return p.source;
      const n = norm(p);
      return n.length > 0 ? escapeRe(n) : null;
    })
    .filter((x): x is string => x !== null);
  if (parts.length === 0) return NEVER_RE;
  return new RegExp(`\\s*(?:${parts.join('|')})\\s*`, flags);
}

interface ResolvedOptions {
  locale: string;
  markdown: MarkdownFlattener | undefined;
  excerptIsMarkdown: boolean;
  trimMd: boolean;
  expand: boolean;
  allowCrossBlock: boolean;
  maxCrossBlocks: number;
  profile: LanguageProfile;
  ignoreCase: boolean;
  ignorePunctuation: boolean;
  ignoreWidth: boolean;
  ignoreParticles: boolean | ParticleTagger;
  numberGrouping: boolean;
  groupingUnderscore: boolean;
  cjkNumerals: boolean;
  cjkNumeralParser?: ChineseNumeralParser;
  splitCamelCase: boolean;
  normalizeIdentifierSeparators: boolean;
  allowSegmented: boolean;
  minSegmentLength: number;
  maxGap: number;
  checkPolarity: boolean;
  negationLexicon?: NegationLexicon;
  /** 带 g：切分锚点用 */
  ellipsisSplit: RegExp;
  /** 不带 g：探测用 */
  ellipsisTest: RegExp;
  minFallbackScore: number;
  fallbacks: readonly FallbackMatcher[];
}

interface NormOpts {
  ignoreCase: boolean;
  ignorePunctuation: boolean;
  ignoreWidth: boolean;
  dropSpaceBetweenCJK: boolean;
  ignoreParticles: boolean | ParticleTagger;
  numberGrouping: boolean;
  groupingUnderscore: boolean;
  cjkNumerals: boolean;
  cjkNumeralParser?: ChineseNumeralParser;
  splitCamelCase: boolean;
  normalizeIdentifierSeparators: boolean;
}

function toNormalizationOptions(r: ResolvedOptions): NormOpts {
  return {
    ignoreCase: r.ignoreCase,
    ignorePunctuation: r.ignorePunctuation,
    ignoreWidth: r.ignoreWidth,
    dropSpaceBetweenCJK: r.profile.dropSpaceBetweenCJK,
    ignoreParticles: r.ignoreParticles,
    numberGrouping: r.numberGrouping,
    groupingUnderscore: r.groupingUnderscore,
    cjkNumerals: r.cjkNumerals,
    cjkNumeralParser: r.cjkNumeralParser,
    splitCamelCase: r.splitCamelCase,
    normalizeIdentifierSeparators: r.normalizeIdentifierSeparators,
  };
}

function spanOpts(r: ResolvedOptions, flat: FlatResult | undefined): { trimMd: boolean; expand: boolean; flat: FlatResult | undefined } {
  return { trimMd: r.trimMd, expand: r.expand, flat };
}

/** md 源码 →（摊平）→ 渲染文本 →（归一化）→ 归一化文本，映射复合后仍指向 md 源码 */
/** 一个匹配视图 */
interface View {
  /** 可见文本（T0 用）；md 模式下是摊平结果，纯文本模式下就是 pageContent 本身 */
  raw: string;
  /** raw 下标 → 源码下标的映射（T0 回切用）；null = 恒等（纯文本模式） */
  rawIdx: NormalizedText | null;
  /** 归一化文本（T1/T2 用） */
  norm: NormalizedText;
}

interface Built {
  /** 严格视图（保留块间分隔符） */
  strict: View;
  blocks: FlatBlock[];
  /** 摊平结果；null = 纯文本模式 */
  flat: FlatResult | null;
  /**
   * 无分隔符视图（跨块摘录用）。
   *
   * 必须和严格视图一起参与「取最早」的比较：否则一个落在后面的字面匹配
   * （T0 命中）会压过前面更靠前的跨块匹配 —— 顺序就错了。
   * 因此这里不做惰性构建，改为首次访问时构建并缓存。
   */
  joined(): View | null;
}

function buildHay(pageContent: string, r: ResolvedOptions): Built {
  if (!r.markdown) {
    const norm = normalizeWithMap(pageContent, toNormalizationOptions(r));
    return {
      strict: { raw: pageContent, rawIdx: null, norm },
      blocks: [],
      flat: null,
      joined: () => null,
    };
  }
  const flat = r.markdown.flatten(pageContent);
  const hay = normalizeWithMap(flat, toNormalizationOptions(r));
  let cached: View | null | undefined;
  return {
    strict: { raw: flat.text, rawIdx: flat, norm: hay },
    blocks: rebaseBlocks(flat.blocks, hay.back),
    flat,
    joined(): View | null {
      if (cached === undefined) {
        const j = r.maxCrossBlocks >= 1 ? deriveJoined(flat) : null;
        cached = j ? { raw: j.text, rawIdx: j, norm: normalizeWithMap(j, toNormalizationOptions(r)) } : null;
      }
      return cached;
    },
  };
}

/** 块边界是「摊平文本」的坐标系，而 hay.text 是归一化后的 —— 必须换算，否则对不上 */
function rebaseBlocks(blocks: FlatBlock[], back: number[] | undefined): FlatBlock[] {
  if (!back || back.length === 0) return blocks;
  const toNorm = (pos: number): number => {
    let lo = 0;
    let hi = back.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (back[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
  return blocks.map((b) => ({ ...b, start: toNorm(b.start), end: toNorm(b.end) }));
}

/** 先套用预设（若指定），再解析 —— 保证显式项覆盖预设 */
function resolve(input: MatchOptions, pageContent: string): ResolvedOptions {
  const o = withPreset(input);
  const profile = o.locale && o.locale !== 'auto' ? languageProfileFor(o.locale) : detectLanguageProfile(pageContent);
  // 省略号模式要按「页面的归一化规则」归一，否则匹配不到归一化后的文本
  const normPattern = (x: string): string =>
    normalizeWithMap(x, {
      ignoreCase: o.ignoreCase ?? true,
      ignorePunctuation: o.ignorePunctuation ?? false,
      ignoreWidth: o.ignoreWidth ?? true,
      dropSpaceBetweenCJK: profile.dropSpaceBetweenCJK,
      ignoreParticles: o.ignoreParticles ?? false,
      numberGrouping: o.numberGrouping ?? true,
      groupingUnderscore: o.groupingUnderscore ?? false,
      cjkNumerals: o.cjkNumerals ?? false,
      cjkNumeralParser: o.cjkNumeralParser,
      splitCamelCase: o.splitCamelCase ?? false,
      normalizeIdentifierSeparators: o.normalizeIdentifierSeparators ?? false,
    }).text;
  const locale = o.locale && o.locale !== 'auto' ? o.locale : profile.id;
  return {
    locale,
    markdown: o.markdown,
    excerptIsMarkdown: o.excerptIsMarkdown ?? false,
    trimMd: o.trimMarkdownEdges ?? false,   // 精确优先：不修剪
    expand: o.expandMarkers ?? true,
    allowCrossBlock: o.allowCrossBlock ?? true,
    maxCrossBlocks: o.allowCrossBlock === false ? 1 : (o.maxCrossBlocks ?? Infinity),
    profile,
    ignoreCase: o.ignoreCase ?? true,
    ignorePunctuation: o.ignorePunctuation ?? false,
    ignoreWidth: o.ignoreWidth ?? true,
    ignoreParticles: o.ignoreParticles ?? false, // 默认不折叠：误判代价高于漏判
    numberGrouping: o.numberGrouping ?? true,
    groupingUnderscore: o.groupingUnderscore ?? false,
    cjkNumerals: o.cjkNumerals ?? false,
    cjkNumeralParser: o.cjkNumeralParser,
    splitCamelCase: o.splitCamelCase ?? false,
    normalizeIdentifierSeparators: o.normalizeIdentifierSeparators ?? false,
    allowSegmented: o.allowSegmented ?? true,
    minSegmentLength: o.minSegmentLength ?? 4,
    maxGap: o.maxGap ?? Infinity,
    checkPolarity: o.checkPolarity ?? true,
    negationLexicon: o.negationLexicon,
    ellipsisSplit: buildEllipsisRe(o.ellipsis ?? DEFAULT_ELLIPSIS, 'g', normPattern),
    ellipsisTest: buildEllipsisRe(o.ellipsis ?? DEFAULT_ELLIPSIS, '', normPattern),
    minFallbackScore: o.minFallbackScore ?? 0.75,
    fallbacks: o.fallbacks ?? [],
  };
}

function countOccurrences(hay: string, needle: string, cap = 50): number {
  let n = 0;
  let at = hay.indexOf(needle);
  while (at >= 0) {
    n++;
    if (n >= cap) return n;
    at = hay.indexOf(needle, at + 1);
  }
  return n;
}

/**
 * 标注 crossesBlocks，并强制「相邻、不跳过整段」。
 * 返回 null 表示违规，该候选作废。
 *
 * 相邻性按**有文本的块**计算：图片块、分隔线这类不产生文本的块不算被跳过。
 */
function withBlockInfo(
  m: ExcerptMatch,
  flat: FlatResult | undefined,
  r: ResolvedOptions
): ExcerptMatch | null {
  if (!flat || flat.blocks.length === 0) return m;

  const srcStart = m.index;
  const srcEnd = m.index + m.length;

  // 只统计有实际文本的块
  const textIdx: number[] = [];
  for (let i = 0; i < flat.blocks.length; i++) {
    const b = flat.blocks[i];
    if (b.end > b.start) textIdx.push(i);
  }
  const hits: number[] = [];
  for (const i of textIdx) {
    const b = flat.blocks[i];
    if (b.srcStart < srcEnd && b.srcEnd > srcStart) hits.push(i);
  }
  if (hits.length === 0) return m;

  // 不跳过：命中的块在有文本的块序列里必须是连续的一段
  const firstPos = textIdx.indexOf(hits[0]);
  const lastPos = textIdx.indexOf(hits[hits.length - 1]);
  if (lastPos - firstPos + 1 !== hits.length) return null;

  if (hits.length > r.maxCrossBlocks) return null;

  return { ...m, crossesBlocks: hits.length > 1 };
}

/**
 * 把归一化空间中的区间回切成源码中的精确 span。
 *
 * 「精确」有两层含义：
 * 1. 起点取 `map[start]`，终点取 `mapEnd[end - 1]`。后者不可由前者推算 ——
 *    转义（`\*` → `*`）与实体（`&amp;` → `&`）让一个可见字符横跨多个源码字符。
 * 2. md 模式下再向两侧补齐完整的行内标记，避免切出 `被告**的行为` 这种半截片段。
 *
 * @param pageContent 原始内容，用于字形簇对齐
 * @param hay 归一化索引（含 `map` / `mapEnd`）
 * @param start 归一化空间起始下标（含）
 * @param end 归一化空间结束下标（不含）
 * @param opts.trimMd 是否修剪首尾的 md 语法标记
 * @param opts.expand 是否扩展到完整的行内标记
 * @param opts.flat 摊平结果，`expand` 为 true 时必需
 * @returns `{ index, length }`，`pageContent.slice(index, index + length)` 即命中片段
 */
export function spanFromNormalized(
  pageContent: string,
  hay: NormalizedText,
  start: number,
  end: number,
  opts: { trimMd?: boolean; expand?: boolean; flat?: FlatResult | undefined } = {}
): { index: number; length: number } {
  const s = Math.max(0, Math.min(start, hay.map.length - 1));
  const e = Math.max(s, Math.min(end - 1, hay.map.length - 1));
  const endArr = hay.mapEnd ?? hay.map;

  let srcStart = hay.map[s];
  let srcEnd = Math.max(srcStart, endArr[e]);

  const flat = opts.flat;
  if (opts.expand && flat && hay.back) {
    const fs = Math.min(hay.back[s] ?? s, (flat.inl?.length ?? 0) - 1);
    const fe = Math.min(hay.back[e] ?? e, (flat.inl?.length ?? 0) - 1);
    const ex = expandToInlineMarkers(flat, fs, fe, srcStart, srcEnd);
    srcStart = ex.start;
    srcEnd = ex.end;
  }

  const sp = snapToGraphemeBoundary(pageContent, srcStart, srcEnd - srcStart);
  return opts.trimMd ? trimMarkdownEdges(pageContent, sp.index, sp.length) : sp;
}

/**
 * 取归一化区间在「渲染文本」中的片段。
 *
 * md 模式下 `view.raw` 是**摊平后**的可见文本（已剥掉 `**`、`[](url)` 等语法），
 * 用它和摘录比较才有意义 —— 拿 md 源码比会把语法标记算进差异里。
 */
function renderedSpanOf(view: View, start: number, end: number): string {
  const e = Math.max(start, end - 1);
  const back = view.norm.back;
  if (back && back.length > 0) {
    // back：归一化下标 → view.raw（摊平后的可见文本）下标
    const bs = back[Math.max(0, Math.min(start, back.length - 1))] ?? start;
    const be = back[Math.max(0, Math.min(e, back.length - 1))] ?? e;
    return view.raw.slice(bs, be + 1);
  }
  // 退化：无 back 时用 map 直接回切（纯文本模式下 view.raw 就是源码）
  const map = view.norm.map;
  const mapEnd = view.norm.mapEnd ?? map;
  const bs = map[Math.max(0, Math.min(start, map.length - 1))];
  const be = mapEnd[Math.max(0, Math.min(e, mapEnd.length - 1))];
  return view.raw.slice(bs, Math.max(bs, be));
}

/**
 * 判断命中是否**跨越了标点差异**。
 *
 * 做法：把页面片段与摘录各自按 `ignorePunctuation: false` 重新归一化再比较。
 * 不同 → 说明是「忽略标点」才匹配上的，即跨越了差异。
 *
 * @remarks
 * **为什么不用「片段里是否有标点被折叠」**：那样只要开了选项就会全部标 true。
 * 真正需要区分的是「有没有跨过差异」—— 标点完全一致的摘录本就该 `exact` 命中，
 * 不该被送去人工复核。
 *
 * 未开 `ignorePunctuation` 时直接短路返回 `false`：
 * 此时 T1/T2 不可能跨标点，T3/T4 的差异体现在 `score` 上而非这里。
 */
function punctuationDiverges(
  view: View,
  start: number,
  end: number,
  excerptRendered: string,
  r: ResolvedOptions
): boolean {
  if (!r.ignorePunctuation) return false;
  const strict = { ...toNormalizationOptions(r), ignorePunctuation: false };
  const pageSide = normalizeWithMap(renderedSpanOf(view, start, end), strict).text;
  const excerptSide = normalizeWithMap(excerptRendered, strict).text;
  return pageSide !== excerptSide;
}

/** T2：摘录自带省略号 → 切成若干锚点，按顺序链式定位 */
function findSegmented(hay: NormalizedText, needle: string, r: ResolvedOptions): Candidate | null {
  const parts = needle.split(r.ellipsisSplit).filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  let cursor = 0;
  let start = -1;
  let end = -1;
  for (const p of parts) {
    if (p.split('\u0001').join('').length < r.minSegmentLength) return null; // 碎片会散布全篇 → 拒绝
    const at = hay.text.indexOf(p, cursor);
    if (at < 0) return null;
    if (start < 0) start = at;
    if (end >= 0 && at - end > r.maxGap) return null;
    end = at + p.length;
    cursor = end;
  }
  return start < 0 ? null : { start, end, score: 1 };
}

/**
 * 文本索引：预建好的归一化视图，供多次 {@link TextIndex.locate} 复用。
 *
 * @remarks
 * 页面归一化（含 md 摊平）是 O(n) 的重活。逐条摘录调用 {@link locateExcerpt}
 * 会对同一页面重复整页处理。实测 600KB 页面：单次 ~200ms，复用索引后 ~7ms。
 *
 * @example
 * ```ts
 * const idx = createTextIndex(page, { markdown: md });
 * for (const it of items) console.log(idx.locate(it.excerpt));
 * ```
 *
 * @remarks
 * 命名说明：它索引的是**文本**（可以是 md 源码，也可以是纯文本），
 * 不是"页面" —— 旧名 `PageIndex` 容易让人联想到页码，故改名。
 */
export interface TextIndex {
  /** 原始内容（md 源码或纯文本） */
  readonly raw: string;

  /**
   * 归一化后的纯文本。
   * md 模式下是「渲染后可见文本」再归一化的结果，用于调试与语义召回。
   */
  readonly text: string;

  /** 归一化索引（含下标映射）；语义层段内对齐、调试时用 */
  readonly norm: NormalizedText;

  /**
   * 建索引时实际生效的归一化选项。
   *
   * @remarks
   * **摘录侧必须用同一套选项归一化**，否则摘录与页面不在同一个空间里，
   * 怎么匹配都对不上。`locateSemantic` 用它来归一化摘录。
   */
  readonly normalizeOptions: NormalizeOptions;

  /** markdown 块切片，坐标系与 `text` 一致；纯文本模式下为空数组 */
  readonly blocks: readonly FlatBlock[];

  /**
   * 在该页面中定位一条摘录。
   * @param excerpt 摘录文本（默认来自渲染后的页面）
   * @returns 统一形状的结果，未命中为 {@link NO_MATCH}
   */
  locate(excerpt: string): ExcerptMatch;
}

/**
 * 兼容旧名。
 *
 * @deprecated 用 {@link createTextIndex} —— 它索引的是文本，不是"页面"。
 */
export type PageIndex = TextIndex;

/**
 * 建索引并复用。
 *
 * 一个页面查多条摘录时**必须**用它 —— 否则每条摘录都会重跑整页归一化与 md 摊平。
 *
 * @param pageContent 页面正文（md 源码或纯文本）
 * @param options 匹配选项，见 {@link MatchOptions}
 * @returns 文本索引，见 {@link TextIndex}
 *
 * @example
 * ```ts
 * const idx = createTextIndex(mdSource, { markdown: md });
 * const a = idx.locate('第一段…');
 * const b = idx.locate('第二段…');
 * ```
 *
 * @remarks
 * 单次查询用 {@link locateExcerpt} 即可；**多次查询同一份文本时才需要它**。
 * 实测 800 段 md：复用 1.96ms / 次，每次重建 165.5ms —— 约 80 倍。
 */
export function createTextIndex(pageContent: string, options: MatchOptions = {}): TextIndex {
  const r = resolve(options, pageContent);
  let cached: Built | null = null;
  const built = (): Built => (cached ??= buildHay(pageContent, r));
  const norm = (): NormalizedText => built().strict.norm;

  return {
    raw: pageContent,
    // 摘录侧要用同一套选项归一化，否则两边不在同一个空间里（见 locateSemantic）
    normalizeOptions: toNormalizationOptions(r),
    get text(): string {
      return norm().text;
    },
    get norm(): NormalizedText {
      return norm();
    },
    get blocks(): readonly FlatBlock[] {
      return built().blocks;
    },
    locate(excerpt: string): ExcerptMatch {
      return locateIn(excerpt, pageContent, built(), r);
    },
  };
}

/**
 * 在页面中定位摘录，返回 md 源码（或原文）中的精确坐标。
 *
 * 分层依次尝试，命中即返回：
 * 1. **T0 exact** —— 在可见文本上逐字符比对
 * 2. **T1 normalized** —— 归一化（空白 / 全半角 / 标点 / 大小写 / 零宽）后比对
 * 3. **T2 segmented** —— 摘录自带省略号时，按分段锚点链式定位
 * 4. **T3 / T4** —— 交给 {@link MatchOptions.fallbacks}（默认关闭）
 *
 * 两个视图（严格 / 无分隔符）的候选一起比较，**位置优先于强度** ——
 * 保证返回的是「第一个」命中，而不是碰巧短路在某个更靠后的字面匹配上。
 *
 * @param excerpt 摘录文本。默认视为用户从渲染后页面复制的纯文本；
 *                若来自 md 源码，请设 {@link MatchOptions.excerptIsMarkdown} 为 true
 * @param pageContent 页面正文（md 源码或纯文本）
 * @param options 匹配选项，见 {@link MatchOptions}
 * @returns 统一形状的结果，见 {@link ExcerptMatch}。未命中为 {@link NO_MATCH}
 *
 * @example 纯文本
 * ```ts
 * locateExcerpt('本院认为，被告构成违约', page);
 * ```
 *
 * @example markdown
 * ```ts
 * locateExcerpt('本院认为，被告的行为构成违约', mdSource, { markdown: md });
 * ```
 *
 * @example 宽松（允许错字）
 * ```ts
 * locateExcerpt(ex, mdSource, { markdown: md, fallbacks: [fuzzy], minFallbackScore: 0.85 });
 * ```
 */
export function locateExcerpt(excerpt: string, pageContent: string, options: MatchOptions = {}): ExcerptMatch {
  if (!excerpt || !pageContent) return NO_MATCH;
  const r = resolve(options, pageContent);
  return locateIn(excerpt, pageContent, buildHay(pageContent, r), r);
}

/** 参与匹配的视图：严格视图 + 无分隔符视图（后者可能不存在） */
function collectSearchableViews(built: Built): View[] {
  const j = built.joined();
  return j ? [built.strict, j] : [built.strict];
}

/** 命中强度，用于同位置时的取舍：精确 > 归一化 > 分段 */
function strength(m: ExcerptMatch): number {
  if (m.kind === 'exact') return 0;
  if (m.kind === 'normalized') return 1;
  if (m.kind === 'segmented') return 2;
  return 3;
}

/**
 * 在单个视图上跑 T1（归一化精确）+ T2（分段锚点）。
 * 严格视图与无分隔符视图共用这段逻辑，保证两者行为一致。
 */
function tryDirect(
  pageContent: string,
  needle: string,
  excerptRendered: string,
  view: View,
  r: ResolvedOptions,
  flat: FlatResult | undefined
): ExcerptMatch | null {
  const at = view.norm.text.indexOf(needle);
  if (at >= 0) {
    return {
      ...spanFromNormalized(pageContent, view.norm, at, at + needle.length, spanOpts(r, flat)),
      kind: 'normalized',
      score: 1,
      occurrences: countOccurrences(view.norm.text, needle),
      punctFolded: punctuationDiverges(view, at, at + needle.length, excerptRendered, r),
    };
  }
  if (r.allowSegmented && r.ellipsisTest.test(needle)) {
    const seg = findSegmented(view.norm, needle, r);
    if (seg) {
      return {
        ...spanFromNormalized(pageContent, view.norm, seg.start, seg.end, spanOpts(r, flat)),
        kind: 'segmented',
        score: 1,
        occurrences: 1,
        punctFolded: punctuationDiverges(view, seg.start, seg.end, excerptRendered, r),
      };
    }
  }
  return null;
}

interface FallbackPick {
  c: Candidate;
  via: string;
  kind: 'fuzzy' | 'semantic';
  /** 命中所在的视图。保留整个 `View` 而非只有 `norm` —— 判定 `punctFolded` 需要 `raw` */
  view: View;
}

/**
 * 依次尝试各 fallback（前面的更"硬"，命中即停），每个 fallback 先在严格视图上试，
 * 再在无分隔符视图上试（跨块摘录）。
 */
function pickBestFallbackCandidate(
  needle: string,
  built: Built,
  r: ResolvedOptions,
  ctx: MatchContext
): FallbackPick | null {
  const views = collectSearchableViews(built);
  // 极性守卫放在**候选过滤**阶段而不是命中之后：
  // 若只在最高分候选上判一次，会出现「最优候选极性冲突 → 直接 NO_MATCH」，
  // 而次优候选其实合法。过滤掉冲突项，让排序自然落在最好的合法候选上。
  const need = r.checkPolarity ? detectNegation(needle, r.negationLexicon) : null;

  for (const fb of r.fallbacks) {
    let best: FallbackPick | null = null;
    for (const view of views) {
      const cands = fb.find(needle, view.norm, ctx);
      if (!cands) continue;
      for (const c of cands) {
        if (c.score < r.minFallbackScore) continue;
        if (need) {
          // 只比较命中 span 内的原文，不用全文 —— 页面别处有「不」很正常
          const inSpan = view.norm.text.slice(c.start, c.end);
          if (negationsConflict(need, detectNegation(inSpan, r.negationLexicon))) continue;
        }
        if (!best || c.score > best.c.score) best = { c, via: fb.name, kind: fb.kind, view };
      }
    }
    if (best) return best; // 前面的 fallback 更"硬"，命中即停
  }
  return null;
}

function locateIn(
  excerpt: string,
  pageContent: string,
  built: Built,
  r: ResolvedOptions
): ExcerptMatch {
  const flat = built.flat ?? undefined;
  if (!excerpt || !pageContent) return NO_MATCH;

  const cands: ExcerptMatch[] = [];

  /**
   * T0 精确。
   * md 场景下「原文」= 渲染后可见文本，不是 md 源码 —— 否则摘录里出现 ** 反而能"命中"，
   * 而用户永远复制不出带 ** 的文本。故在可见文本上比对（含无分隔符视图）。
   */
  if (!r.excerptIsMarkdown) {
    for (const v of collectSearchableViews(built)) {
      const at = v.raw.indexOf(excerpt);
      if (at < 0) continue;
      const m = withBlockInfo(
        {
          ...(v.rawIdx
            ? spanFromNormalized(pageContent, v.rawIdx, at, at + excerpt.length, spanOpts(r, flat))
            : snapToGraphemeBoundary(pageContent, at, excerpt.length)),
          kind: 'exact',
          score: 1,
          occurrences: countOccurrences(v.raw, excerpt),
          // exact = 字面完全一致，不可能跨越标点差异；显式给出，便于调用方无条件检查
          punctFolded: false,
        },
        flat,
        r
      );
      if (m) cands.push(m);
    }
    if (cands.length === 0 && !flat) {
      // 纯文本模式：可见文本就是 pageContent，上面已覆盖；这里仅兜底
      const raw = pageContent.indexOf(excerpt);
      if (raw >= 0) {
        cands.push({
          ...snapToGraphemeBoundary(pageContent, raw, excerpt.length),
          kind: 'exact',
          score: 1,
          occurrences: countOccurrences(pageContent, excerpt),
          punctFolded: false,
        });
      }
    }
  }

  // 摘录侧：默认视为渲染后的纯文本；只有明确说来自 md 源码才摊平
  const excerptBase = r.excerptIsMarkdown && r.markdown ? r.markdown.flatten(excerpt) : excerpt;
  // 判定 punctFolded 时要拿**渲染后**的摘录文本与页面片段比，
  // 若摘录来自 md 源码需先摊平，否则语法标记会被算进差异
  const excerptRendered = typeof excerptBase === 'string' ? excerptBase : excerptBase.text;
  const needle = normalizeWithMap(excerptBase, toNormalizationOptions(r)).text;

  if (needle.length > 0 && cands.length === 0) {
    // T1/T2：严格视图与无分隔符视图都试，取最早
    for (const v of collectSearchableViews(built)) {
      const m = tryDirect(pageContent, needle, excerptRendered, v, r, flat);
      if (m) {
        const ok = withBlockInfo(m, flat, r);
        if (ok) cands.push(ok);
      }
    }
  }

  // 取**最早**的命中：位置优先于强度。
  // 否则后面段落里一个字面匹配会压过前面更靠前的跨块匹配，顺序就错了。
  if (cands.length > 0) {
    cands.sort((a, b) => a.index - b.index || strength(a) - strength(b));
    return cands[0];
  }

  // T3/T4 交给外部匹配器
  if (needle.length > 0 && r.fallbacks.length > 0) {
    const ctx: MatchContext = {
      locale: r.locale,
      tokenize: (t: string) => tokenize(t, r.profile),
      minScore: r.minFallbackScore,
    };
    const best = pickBestFallbackCandidate(needle, built, r, ctx);
    if (best) {
      const m = withBlockInfo(
        {
          ...spanFromNormalized(pageContent, best.view.norm, best.c.start, best.c.end, spanOpts(r, flat)),
          kind: best.kind,
          score: best.c.score,
          occurrences: 1,
          via: best.via,
          punctFolded: punctuationDiverges(best.view, best.c.start, best.c.end, excerptRendered, r),
        },
        flat,
        r
      );
      if (m) return m;
    }
  }

  return NO_MATCH;
}

/**
 * @deprecated 用 {@link createTextIndex}。旧名暗示"页面"，但它索引的是文本。
 */
export const createPageIndex = createTextIndex;
