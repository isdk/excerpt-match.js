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
import { normalizeWithMap, snapToGraphemeBoundary, withKeep } from '@isdk/normalize-text';
import type { IgnorePunctuationOption } from '@isdk/normalize-text';
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
 * @param norm 与文档/摘录相同的归一化函数
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
  ignorePunctuation: IgnorePunctuationOption;
  /** 生效的省略号模式（`DEFAULT_ELLIPSIS` 或调用方覆盖）—— 给保护区用 */
  ellipsisPatterns: readonly EllipsisPattern[];
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
  ignorePunctuation: IgnorePunctuationOption;
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

/**
 * 把「用户/系统定义的省略表达」并入 `ignorePunctuation` 的保护区。
 *
 * @remarks
 * 省略号是**结构**而不是排版标点：摘录里出现 `……`，是作者明确在说「此处省略」。
 * 折叠掉它，`ignorePunctuation` 就会连带废掉 T2 分段锚点 ——
 * 开启开关反而比关闭更难命中，这与开关的意图正好相反。
 *
 * 所以默认保护；只有 `{ preserveEllipsis: false }` 才允许折叠它们。
 */
function resolveIgnorePunctuation(r: ResolvedOptions): IgnorePunctuationOption {
  return withKeep(r.ignorePunctuation, r.ellipsisPatterns as readonly (string | RegExp)[]);
}

function toNormalizationOptions(r: ResolvedOptions): NormOpts {
  return {
    ignoreCase: r.ignoreCase,
    ignorePunctuation: resolveIgnorePunctuation(r),
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
  /** 可见文本（T0 用）；md 模式下是摊平结果，纯文本模式下就是 text 本身 */
  raw: string;
  /** raw 下标 → 源码下标的映射（T0 回切用）；null = 恒等（纯文本模式） */
  rawIdx: NormalizedText | null;
  /** 归一化文本（T1/T2 用） */
  norm: NormalizedText;
  /**
   * **本视图 raw 坐标系**里的块切片；空 = 无块概念（纯文本模式）。
   *
   * 注意坐标系：严格视图的 raw 是摊平文本（块切片即 `flat.blocks` 原样），
   * joined 视图的 raw 剥掉了分隔符（块切片须换算，见 `rebaseBlocksToJoined`）。
   * 供 `spanWithEdgePunctuation` 把边缘标点扩展夹回块内。
   */
  blocks?: readonly FlatBlock[];
  /**
   * 归一化下标 → **本视图 raw** 下标；缺省 = `norm.back` 已指向本视图 raw。
   *
   * @remarks
   * 为什么 joined 视图必须单独提供：`normalizeWithMap(j)` 会把 `j.back`
   * （joined→摊平）复合进结果的 `back`，所以 joined 视图的 `norm.back`
   * 指向的是**摊平文本**而不是 joined raw —— 直接拿来切 `raw` 会整体错位
   * （偏移量 = 前面剥掉的分隔符数）。这里用 `j.back` 二分补上第二跳。
   */
  normToRaw?: readonly number[];
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

function buildHay(text: string, r: ResolvedOptions): Built {
  if (!r.markdown) {
    const norm = normalizeWithMap(text, toNormalizationOptions(r));
    return {
      strict: { raw: text, rawIdx: null, norm, blocks: [] },
      blocks: [],
      flat: null,
      joined: () => null,
    };
  }
  const flat = r.markdown.flatten(text);
  const hay = normalizeWithMap(flat, toNormalizationOptions(r));
  let cached: View | null | undefined;
  return {
    // 严格视图的 raw 就是摊平文本：块切片原样即在同一坐标系
    strict: { raw: flat.text, rawIdx: flat, norm: hay, blocks: flat.blocks },
    blocks: rebaseBlocks(flat.blocks, hay.back),
    flat,
    joined(): View | null {
      if (cached === undefined) {
        const j = r.maxCrossBlocks >= 1 ? deriveJoined(flat) : null;
        if (!j) {
          cached = null;
        } else {
          const norm = normalizeWithMap(j, toNormalizationOptions(r));
          cached = {
            raw: j.text,
            rawIdx: j,
            norm,
            // norm.back 指向摊平文本（见 View.normToRaw 的备注），补第二跳到 joined raw
            normToRaw: mapFlatBackToJoined(norm.back, j.back ?? []),
            // joined 的 raw 已剥掉分隔符：块切片必须换算到同一坐标系，
            // spanWithEdgePunctuation 才能把扩展夹回块内
            blocks: rebaseBlocksToJoined(flat.blocks, j.back ?? []),
          };
        }
      }
      return cached;
    },
  };
}

/**
 * 块切片换算：摊平 norm 坐标 → joined raw 坐标。
 *
 * joined 的 raw 是摊平文本剥掉分隔符后的结果，`back`（= keep 数组 + 末尾哨兵）
 * 升序，且 `raw 下标 = 严格小于 q 的元素个数` —— 直接二分即得。
 *
 * 注意 `end` 落在分隔符位置上时（块切片的 end 本就是 Exclusive，可能指向紧随其后的分隔符），
 * 二分结果恰好是「块内最后一个 raw 字符的下标 + 1」，作为 Exclusive 终点正合适。
 */
function rebaseBlocksToJoined(blocks: readonly FlatBlock[], back: number[]): FlatBlock[] {
  return blocks.map((b) => ({ ...b, start: flatPosToJoinedRaw(back, b.start), end: flatPosToJoinedRaw(back, b.end) }));
}

/**
 * 归一化 `back`（归一化下标 → 摊平文本下标）再补一跳：摊平下标 → joined raw 下标。
 *
 * @remarks
 * joined 视图的 `norm.back` 指向**摊平文本**（`normalizeWithMap(j)` 把 `j.back`
 * 复合进去了），而 punctFolded 要在 joined raw 上取片段 —— 必须再过一次
 * `j.back`（升序，`raw 下标 = 严格小于 q 的元素个数`）。
 */
function mapFlatBackToJoined(normBack: readonly number[] | undefined, keep: number[]): readonly number[] | undefined {
  if (!normBack || normBack.length === 0) return undefined;
  return normBack.map((f) => flatPosToJoinedRaw(keep, f));
}

/** 摊平下标 → joined raw 下标：`j.back`（= keep + 末尾哨兵）内二分 */
function flatPosToJoinedRaw(back: number[], q: number): number {
  let lo = 0;
  let hi = back.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((back[mid] ?? 0) < q) lo = mid + 1;
    else hi = mid;
  }
  return lo;
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
function resolve(input: MatchOptions, text: string): ResolvedOptions {
  const o = withPreset(input);
  const profile = o.locale && o.locale !== 'auto' ? languageProfileFor(o.locale) : detectLanguageProfile(text);
  // 省略号模式要按「文档的归一化规则」归一，否则匹配不到归一化后的文本。
  //
  // 但**不含 `ignorePunctuation`**：省略表达是自己人，它的形态不能被标点策略改写 ——
  // 既然上面把它放进了保护区（原文保留），这里的切分正则就必须照样指着原文形态，
  // 否则会出现「摘录里留着 `[略]`、切分却按 `略` 去找」的自相矛盾。
  const normPattern = (x: string): string =>
    normalizeWithMap(x, {
      ignoreCase: o.ignoreCase ?? true,
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
  const ellipsisPatterns = o.ellipsis ?? DEFAULT_ELLIPSIS;
  return {
    locale,
    // null = 调用方显式强制纯文本（类型上与 undefined 同义）
    markdown: o.markdown ?? undefined,
    excerptIsMarkdown: o.excerptIsMarkdown ?? false,
    trimMd: o.trimMarkdownEdges ?? false,   // 精确优先：不修剪
    expand: o.expandMarkers ?? true,
    allowCrossBlock: o.allowCrossBlock ?? true,
    maxCrossBlocks: o.allowCrossBlock === false ? 1 : (o.maxCrossBlocks ?? Infinity),
    profile,
    ignoreCase: o.ignoreCase ?? true,
    ignorePunctuation: o.ignorePunctuation ?? false,
    ellipsisPatterns: ellipsisPatterns,
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
    ellipsisSplit: buildEllipsisRe(ellipsisPatterns, 'g', normPattern),
    ellipsisTest: buildEllipsisRe(ellipsisPatterns, '', normPattern),
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
 * @param text 原始内容，用于字形簇对齐
 * @param hay 归一化索引（含 `map` / `mapEnd`）
 * @param start 归一化空间起始下标（含）
 * @param end 归一化空间结束下标（不含）
 * @param opts.trimMd 是否修剪首尾的 md 语法标记
 * @param opts.expand 是否扩展到完整的行内标记
 * @param opts.flat 摊平结果，`expand` 为 true 时必需
 * @returns `{ index, length }`，`text.slice(index, index + length)` 即命中片段
 */
export function spanFromNormalized(
  text: string,
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

  const sp = snapToGraphemeBoundary(text, srcStart, srcEnd - srcStart);
  return opts.trimMd ? trimMarkdownEdges(text, sp.index, sp.length) : sp;
}

/**
 * 取归一化区间在「渲染文本」中的半开区间 `[start, end)`。
 *
 * md 模式下 `view.raw` 是**摊平后**的可见文本（已剥掉 `**`、`[](url)` 等语法），
 * 用它和摘录比较才有意义 —— 拿 md 源码比会把语法标记算进差异里。
 */
function rawBoundsOf(view: View, start: number, end: number): [number, number] {
  const e = Math.max(start, end - 1);
  // joined 视图：normToRaw 已把 norm.back 补到本视图 raw（摊平 → joined 两跳）
  const toRaw = view.normToRaw;
  if (toRaw && toRaw.length > 0) {
    const bs = toRaw[Math.max(0, Math.min(start, toRaw.length - 1))] ?? start;
    const be = toRaw[Math.max(0, Math.min(e, toRaw.length - 1))] ?? e;
    return [bs, be + 1];
  }
  const back = view.norm.back;
  if (back && back.length > 0) {
    // back：归一化下标 → view.raw（摊平后的可见文本）下标
    const bs = back[Math.max(0, Math.min(start, back.length - 1))] ?? start;
    const be = back[Math.max(0, Math.min(e, back.length - 1))] ?? e;
    return [bs, be + 1];
  }
  // 退化：无 back 时用 map 直接回切（纯文本模式下 view.raw 就是源码）
  const map = view.norm.map;
  const mapEnd = view.norm.mapEnd ?? map;
  const bs = map[Math.max(0, Math.min(start, map.length - 1))];
  const be = mapEnd[Math.max(0, Math.min(e, mapEnd.length - 1))];
  return [bs, Math.max(bs, be)];
}

/**
 * 紧邻的标点 / 空白。
 *
 * 注意 `\n` 是 `Cc` 不在 `\p{P}` / `\p{Z}` 里 —— 换行天然是扩展的止点：
 * 它是块边界，**下一段的内容不属于本次命中**，不能顺着吞进去。
 */
const EDGE_PUNCT = /[\p{P}\p{Z}]/u;

/**
 * 命中片段的渲染文本，**含两侧紧邻的边缘标点**，但**不跨块**。
 *
 * @remarks
 * 归一化把首/尾的标点当作可选分隔符丢弃，span 因此常常不含末尾句号 ——
 * 直接拿 span 与摘录比，会出两种错：
 *
 * - 「两边其实都有句号」→ span 侧没有 → **误报**差异（全半角本就不算差异）
 * - 「文档是冒号、摘录是句号」→ 真差异恰好落在边缘 → **漏报**
 *
 * 把文档侧补上紧邻的标点，两种错同时消失：有就有、是什么就是什么。
 * 摘录侧保持原样 —— 它的标点有没有、是什么，本身就是要比对的内容。
 *
 * 两条止步规则：
 * - **止于换行**（严格视图生效）：`\n` 是 `Cc` 不在 `\p{P}` / `\p{Z}` 里，
 *   而换行是块边界，下一段的内容不属于本次命中，不能顺着吞进去。
 * - **止于块边界**（joined 视图生效）：joined 的 raw 已剥掉分隔符，
 *   相邻块直接贴在一起，仅靠上一条挡不住 —— 扩展被夹在本视图块切片的
 *   `[start, end)` 内，不会吞进下一块开头（或上一块结尾）的标点。
 *   否则「摘录末尾的句号其实来自下一块」会被误判成无差异而假放行。
 */
function spanWithEdgePunctuation(view: View, start: number, end: number): string {
  const [bs0, be0] = rawBoundsOf(view, start, end);
  const raw = view.raw;
  // 扩展边界：默认整段 raw；有块切片时夹进命中块（们）的 [start, end) 内。
  // 命中跨多个块时取包围盒 —— 块间的分隔符已剥掉，包围盒内就是拼接后的连续命中区。
  let lo = 0;
  let hi = raw.length;
  const hit = hitBlockBounds(view.blocks, bs0, be0);
  if (hit) {
    lo = hit[0];
    hi = hit[1];
  }
  let s = Math.max(lo, bs0);
  while (s > lo && EDGE_PUNCT.test(raw[s - 1] ?? '')) s--;
  let e = Math.min(hi, be0);
  while (e < hi && EDGE_PUNCT.test(raw[e] ?? '')) e++;
  return raw.slice(s, e);
}

/**
 * 命中区间所在块（们）的 raw 包围盒；`null` = 无块概念或命中落在块外。
 *
 * @remarks
 * 半开区间判定：`b.start < end && start < b.end`，与 `withBlockInfo` 同口径。
 * 有意不取「最近块」：命中若无缘无故落在块外，说明坐标换算已出问题，
 * 宁可退回不夹（保守，保持旧行为）也不硬拉进某个块。
 */
function hitBlockBounds(blocks: readonly FlatBlock[] | undefined, start: number, end: number): [number, number] | null {
  if (!blocks || blocks.length === 0) return null;
  let lo = -1;
  let hi = -1;
  for (const b of blocks) {
    if (b.start < end && start < b.end) {
      if (lo < 0) lo = b.start;
      hi = Math.max(hi, b.end);
    }
  }
  return lo < 0 ? null : [lo, hi];
}

/**
 * 判断命中是否**跨越了标点差异**。
 *
 * 做法：两侧各自按 `ignorePunctuation: false` 重新归一化再比较 ——
 * 文档侧是「span + 紧邻的边缘标点」（不跨块，见 `spanWithEdgePunctuation`），
 * 摘录侧保持原样。不同 → 说明是「忽略标点」才匹配上的，即跨越了差异。
 *
 * @remarks
 * 两侧**不对称**是刻意的：摘录的标点有没有、是什么，本身就是要比对的内容，
 * 所以不能像文档侧那样补边缘；文档侧必须补，因为归一化把它的首尾标点
 * 当可选分隔符删掉了（推演见 `spanWithEdgePunctuation` 的注释）。
 *
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
  // 文档侧 = span + 紧邻的边缘标点（不跨块）；摘录侧 = 原样。两边都过 strict 归一化后比较。
  // 全半角这类宽度差异本就不算差异 —— strict 归一化里的 ignoreWidth 负责折掉它们。
  const rawSpan = spanWithEdgePunctuation(view, start, end);
  const pageSide = normalizeWithMap(rawSpan, strict).text;
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
 * 整篇归一化（含 md 摊平）是 O(n) 的重活。逐条摘录调用 {@link locateExcerpt}
 * 会对同一篇文本重复整篇处理。实测 600KB 文本：单次 ~200ms，复用索引后 ~7ms。
 *
 * @example
 * ```ts
 * const idx = createTextIndex(text, { markdown: md });
 * for (const it of items) console.log(idx.locate(it.excerpt));
 * ```
 *
 * @remarks
 * 命名说明：它索引的是**文本**（可以是 md 源码，也可以是纯文本），
 * 没有分页的概念 —— 故名 `TextIndex` 而非暗示页码的名字。
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
   * @remarks    * **摘录侧必须用同一套选项归一化**，否则摘录与文档不在同一个空间里，
   * 怎么匹配都对不上。`locateSemantic` 用它来归一化摘录。
   */
  readonly normalizeOptions: NormalizeOptions;

  /** markdown 块切片，坐标系与 `text` 一致；纯文本模式下为空数组 */
  readonly blocks: readonly FlatBlock[];

  /**
   * 在该文本中定位一条摘录。
   * @param excerpt 摘录文本（默认来自渲染后的文档）
   * @returns 统一形状的结果，未命中为 {@link NO_MATCH}
   */
  locate(excerpt: string): ExcerptMatch;
}

/**
 * 建索引并复用。
 *
 * 同一篇文本查多条摘录时**必须**用它 —— 否则每条摘录都会重跑整页归一化与 md 摊平。
 *
 * @param text 文档内容（md 源码或纯文本）
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
export function createTextIndex(text: string, options: MatchOptions = {}): TextIndex {
  const r = resolve(options, text);
  let cached: Built | null = null;
  const built = (): Built => (cached ??= buildHay(text, r));
  const norm = (): NormalizedText => built().strict.norm;

  return {
    raw: text,
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
      return locateIn(excerpt, text, built(), r);
    },
  };
}

/**
 * 在文档文本中定位摘录，返回 md 源码（或原文）中的精确坐标。
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
 * @param excerpt 摘录文本。默认视为用户从渲染后文档复制的纯文本；
 *                若来自 md 源码，请设 {@link MatchOptions.excerptIsMarkdown} 为 true
 * @param text 文档内容（md 源码或纯文本）
 * @param options 匹配选项，见 {@link MatchOptions}
 * @returns 统一形状的结果，见 {@link ExcerptMatch}。未命中为 {@link NO_MATCH}
 *
 * @example 纯文本
 * ```ts
 * locateExcerpt('本院认为，被告构成违约', text);
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
export function locateExcerpt(excerpt: string, text: string, options: MatchOptions = {}): ExcerptMatch {
  if (!excerpt || !text) return NO_MATCH;
  const r = resolve(options, text);
  return locateIn(excerpt, text, buildHay(text, r), r);
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
  text: string,
  needle: string,
  excerptRendered: string,
  view: View,
  r: ResolvedOptions,
  flat: FlatResult | undefined
): ExcerptMatch | null {
  const at = view.norm.text.indexOf(needle);
  if (at >= 0) {
    return {
      ...spanFromNormalized(text, view.norm, at, at + needle.length, spanOpts(r, flat)),
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
        ...spanFromNormalized(text, view.norm, seg.start, seg.end, spanOpts(r, flat)),
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
          // 只比较命中 span 内的原文，不用全文 —— 文档别处有「不」很正常
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
  text: string,
  built: Built,
  r: ResolvedOptions
): ExcerptMatch {
  const flat = built.flat ?? undefined;
  if (!excerpt || !text) return NO_MATCH;

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
            ? spanFromNormalized(text, v.rawIdx, at, at + excerpt.length, spanOpts(r, flat))
            : snapToGraphemeBoundary(text, at, excerpt.length)),
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
      // 纯文本模式：可见文本就是 text，上面已覆盖；这里仅兜底
      const raw = text.indexOf(excerpt);
      if (raw >= 0) {
        cands.push({
          ...snapToGraphemeBoundary(text, raw, excerpt.length),
          kind: 'exact',
          score: 1,
          occurrences: countOccurrences(text, excerpt),
          punctFolded: false,
        });
      }
    }
  }

  // 摘录侧：默认视为渲染后的纯文本；只有明确说来自 md 源码才摊平
  const excerptBase = r.excerptIsMarkdown && r.markdown ? r.markdown.flatten(excerpt) : excerpt;
  // 判定 punctFolded 时要拿**渲染后**的摘录文本与文档片段比，
  // 若摘录来自 md 源码需先摊平，否则语法标记会被算进差异
  const excerptRendered = typeof excerptBase === 'string' ? excerptBase : excerptBase.text;
  const needle = normalizeWithMap(excerptBase, toNormalizationOptions(r)).text;

  if (needle.length > 0 && cands.length === 0) {
    // T1/T2：严格视图与无分隔符视图都试，取最早
    for (const v of collectSearchableViews(built)) {
      const m = tryDirect(text, needle, excerptRendered, v, r, flat);
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
          ...spanFromNormalized(text, best.view.norm, best.c.start, best.c.end, spanOpts(r, flat)),
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


