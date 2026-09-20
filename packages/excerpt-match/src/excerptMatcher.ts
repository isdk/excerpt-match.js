/**
 * 高层入口：一条摘录进来，T0–T4 全档位编排，返回**结论 + 可引用原文 + 完整元数据**。
 *
 * ## 与低层原语的分工
 *
 * | 层 | API | 职责 |
 * |---|---|---|
 * | 高层（本文件） | `matchExcerpt` / `createExcerptMatcher` | 编排 T0–T4，组装「结论 + 原文 + 元数据」 |
 * | 低层（同步） | `locateExcerpt` / `createTextIndex` | 纯 T0–T3 定位，只回坐标元数据 |
 * | 低层（T4） | `locateSemantic` | 语义召回的坐标适配，被本文件调用 |
 *
 * 低层原语仍然独立可用（同步、无回调、无 T4）；要「一步到位的结论」就用本入口。
 *
 * ## 零配置可用
 *
 * 本入口的每个依赖都有内置默认（见 `./defaults`，依赖已必装）：
 *
 * | 选项 | 不传时 |
 * |---|---|
 * | `markdown` | 内置 md 摊平器（mdast + GFM）；传 `null` 强制纯文本 |
 * | `fallbacks` | 内置 `diff-match-patch-es` 模糊匹配器（`strict` 档除外） |
 * | `aligner` | 与 `fallbacks` 同源，用于 T4 段内对齐 |
 * | `cjkNumeralParser` | 开了 `cjkNumerals` 时自动装配 `cjk-number` |
 * | `ignoreParticles: true` | 自动升级为内置 jieba 词性判定器 |
 *
 * 显式传入的选项永远覆盖默认。唯一没有默认的是 `retriever` ——
 * 语义召回需要 embedding / BM25 这类外部服务，本包不自带，不传就绝不碰语义层。
 *
 * ## 结果为什么不是布尔
 *
 * 命中之后紧接着要做的通常是**引用**：展示那一段原文、高亮它、跳转到它。
 * 所以结果里直接带上 `source`（md 源码片段）与 `text`（剥掉语法标记的可见文本）；
 * 同时它 `extends ExcerptMatch` —— `occurrences` / `punctFolded` / `crossesBlocks`
 * 这些判定歧义与严格性的字段一个不少，调用方不用在两个返回形状之间挑。
 *
 * ## T3 / T4 可以叠加
 *
 * - `fallbacks`（T3 与任意自定义匹配器，**含语义型**）在同步定位阶段按序尝试；
 * - `retriever` + `aligner`（两阶段语义召回：召回给粗位置，段内确定性对齐给精确坐标）
 *   只在同步层未命中时启用。
 *
 * 两条路互不排斥：同时配置时，T0–T3（含 fallbacks）先走，未命中才动用召回。
 * 索引建好后，批量场景请用 {@link createExcerptMatcher} 复用 ——
 * 整篇归一化（含 md 摊平）是 O(n) 的重活。
 *
 * ## 为什么是异步
 *
 * T4 的召回器允许返回 Promise（embedding / 云 API）。统一异步让调用方式
 * 与配置解耦：无论开没开 T4，`await matchExcerpt(...)` 都是同一个写法。
 *
 * @packageDocumentation
 */

import { createTextIndex } from './locator';
import { locateSemantic } from './semanticMatch';
import type { TextIndex } from './locator';
import type { SemanticRetriever } from './semanticMatch';
import type { ExcerptMatch, FallbackMatcher, MarkdownFlattener, MatchOptions } from './types';
import { NO_MATCH, isHit } from './types';
import {
  defaultCjkNumberParser,
  defaultFuzzyFallback,
  defaultMarkdownFlattener,
  defaultParticleTagger,
} from './defaults';

/**
 * 高层入口的选项 = {@link MatchOptions} 全集 + 编排层自己的配置。
 *
 * @remarks
 * 依赖注入项全部有默认（见上文「零配置可用」），只有 `retriever` 必须显式给。
 * 「命中即回调」的事件从配置传入，调用方不必为了拿回调再包一层。
 */
export interface ExcerptMatcherOptions extends MatchOptions {
  /**
   * T4 的外部召回器（embedding / BM25 …）。**给了它才会走语义层**，
   * 本包不自带任何召回实现 —— 那是另一个领域。
   */
  retriever?: SemanticRetriever;
  /**
   * T4 的段内再对齐器（如 `createDmpEsFallback(dmpEs)`）。
   * 不传则用内置默认模糊匹配器；**没有 retriever 时本项无意义**。
   */
  aligner?: FallbackMatcher;
  /**
   * T3 / T4 命中的最低可接受置信度。
   *
   * @remarks
   * T0–T2 恒为 1，不受它约束 —— 只有近似层与语义层受门槛管辖。
   * @defaultValue `options.minFallbackScore ?? 0.75`
   */
  minScore?: number;
  /** 命中回调：拿到的是已组装好的 {@link ExcerptMatchResult}，可直接用于引用 / 高亮 / 埋点 */
  onHit?: (excerpt: string, result: ExcerptMatchResult) => void;
  /** 未命中回调；未配置就是静默 —— 库不该默认往控制台打印 */
  onMiss?: (excerpt: string, result: ExcerptMatch) => void;
}

/**
 * 高层入口的统一返回：定位元数据 + 结论 + 可引用原文，命中与否都是这个形状。
 *
 * @remarks
 * `extends ExcerptMatch` 是刻意为之：`occurrences`（歧义）、`punctFolded`
 * （是否靠忽略标点才命中）、`crossesBlocks`（跨块）这些决定「敢不敢直接用」
 * 的字段直接在结果上，不需要再调一次 `locateExcerpt` 补齐。
 */
export interface ExcerptMatchResult extends ExcerptMatch {
  /** 是否命中 —— 「是不是出自这篇文本」的结论 */
  found: boolean;
  /**
   * 命中的 **md 源码片段**，等价于对**传入文本**做切片：
   * `slice(index, index + length)`（注意不是本结果的 `text` 字段）。
   *
   * @remarks
   * md 模式下它**含语法标记**（`**`、`[](url)`、反引号）—— 引用该引的是源码，
   * 而不是渲染后文本；未命中为空串。
   */
  source: string;
  /** 命中片段的渲染后可见文本（剥掉语法标记），便于展示；未命中为空串 */
  text: string;
  /** 1-based 行号，可直接高亮；未命中为 -1 */
  line: number;
}

/** 批量入口：预建索引，同一篇文本对多条摘录时复用 */
export interface ExcerptMatcher {
  /** 预建好的索引 —— 摘录侧的归一化选项也来自它，保证两边在同一空间 */
  index: TextIndex;
  /**
   * 匹配一条摘录：T0–T4 全档位（T4 仅在给了 `retriever` 时才可能发生）。
   *
   * @remarks
   * 构造时配置的 `onHit` / `onMiss` 在每次调用后触发。
   */
  match(excerpt: string): Promise<ExcerptMatchResult>;
}

/** 解析默认依赖后的编排选项 —— 组装一次，`match` 闭包直接用 */
interface ResolvedMatcherOptions {
  /** 传给 `createTextIndex` 的匹配选项（默认值已装配） */
  match: MatchOptions;
  /** 生效的 md 摊平器；`undefined` = 纯文本模式（供 `toResult` 取可见文本） */
  markdown?: MarkdownFlattener;
  retriever?: SemanticRetriever;
  aligner?: FallbackMatcher;
  minScore: number;
  onHit?: ExcerptMatcherOptions['onHit'];
  onMiss?: ExcerptMatcherOptions['onMiss'];
}

/**
 * 把「调用方传的 + 内置默认」装配成最终选项。
 *
 * @remarks
 * 装配原则：**显式传入永远赢**。`fallbacks` 与 `markdown` 需要区分
 * 「没传」与「显式传了空/取消」，所以逐项处理而不是一把 spread。
 */
function resolveMatcherOptions(o: ExcerptMatcherOptions): ResolvedMatcherOptions {
  const { retriever, aligner, minScore, onHit, onMiss, markdown, fallbacks, cjkNumeralParser, ignoreParticles, ...rest } = o;

  // md 摊平器：不传 → 内置默认（mdast + GFM）；显式 null → 纯文本模式
  const md = markdown === undefined ? defaultMarkdownFlattener() : markdown || undefined;

  // T3 模糊层：不传且非 strict 档 → 内置 diff-match-patch-es。
  // strict 档的取舍是「宁可漏，不可错」，绝不自动注入模糊匹配。
  let fbs = fallbacks;
  if (fbs === undefined && o.preset !== 'strict') {
    const fb = defaultFuzzyFallback();
    if (fb) fbs = [fb];
  }

  // 中文数词：开了 cjkNumerals 却没给解析器 → 内置 cjk-number
  let parser = cjkNumeralParser;
  if (!parser && rest.cjkNumerals) parser = defaultCjkNumberParser();

  // 的/地/得：true（内置保守模式）在高层自动升级为 jieba 词性判定 —— 词性感知，保护表补不全的问题不复存在
  let particles = ignoreParticles;
  if (particles === true) {
    const t = defaultParticleTagger();
    if (t) particles = t;
  }

  const match: MatchOptions = {
    ...rest,
    markdown: md,
    fallbacks: fbs,
    cjkNumeralParser: parser,
    ignoreParticles: particles,
  };

  return {
    match,
    markdown: md,
    retriever,
    // T4 段内对齐默认与 T3 同源：召回给了粗位置，确定性对齐给精确坐标
    aligner: aligner ?? defaultFuzzyFallback(),
    minScore: minScoreOf(o),
    onHit,
    onMiss,
  };
}

function minScoreOf(o: ExcerptMatcherOptions): number {
  return o.minScore ?? o.minFallbackScore ?? 0.75;
}

function lineOf(text: string, index: number): number {
  if (index < 0) return -1;
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === '\n') line++;
  return line;
}

/** 未命中的规范结果：kind / score 保留原始判定的信息量（差多少、在哪层失败） */
function missResult(r: ExcerptMatch): ExcerptMatchResult {
  return { ...r, found: false, source: '', text: '', line: -1 };
}

/**
 * 把命中换算成「结论 + 原文 + 元数据」。
 *
 * @remarks
 * `source` 直接切片原文 —— 它是**唯一可作为引用依据**的字段：
 * md 模式下坐标本来就落在源码上（见 README「坐标契约」），切出来的就是作者写的那一段。
 */
function toResult(text: string, r: ExcerptMatch, resolved: ResolvedMatcherOptions): ExcerptMatchResult {
  if (!(isHit(r) && r.score >= resolved.minScore)) return missResult(r);
  const source = text.slice(r.index, r.index + r.length);
  // 可见文本：只对片段单独摊平，用于展示 —— 引用请用 source
  let visible = source;
  if (resolved.markdown) {
    try {
      // 单块片段摊平后尾部会带块分隔符换行 —— 展示用文本去掉它，source 保持原样
      visible = resolved.markdown.flatten(source).text.replace(/\s+$/, '');
    } catch {
      visible = source; // 片段本身可能是半截标记，摊平失败就退回源码
    }
  }
  return {
    ...r,
    found: true,
    source,
    text: visible,
    line: lineOf(text, r.index),
  };
}

/**
 * 建批量匹配器 —— **同一篇文本对多条摘录时用这个**，索引只建一次。
 *
 * @param text 文档内容（md 源码或纯文本）
 * @param options 匹配与编排选项，见 {@link ExcerptMatcherOptions}；全部有默认，可完全不传
 * @returns 批量匹配器，见 {@link ExcerptMatcher}
 *
 * @remarks
 * 整篇归一化（含 md 摊平）是 O(n) 的重活：实测 600KB 文本单次 ~200ms，复用索引后 ~7ms。
 *
 * @example 零配置：内置 md 摊平 + 默认模糊层
 * ```ts
 * const m = createExcerptMatcher(mdSource);
 * for (const it of items) {
 *   const r = await m.match(it.excerpt);
 *   if (r.found) cite(r.source);   // 引用 md 源码片段
 * }
 * ```
 *
 * @example 需要语义召回（T4）时才配置 retriever
 * ```ts
 * const m = createExcerptMatcher(mdSource, { retriever });
 * ```
 */
export function createExcerptMatcher(
  text: string,
  options: ExcerptMatcherOptions = {}
): ExcerptMatcher {
  const resolved = resolveMatcherOptions(options);
  const index = createTextIndex(text, resolved.match);

  const match = async (excerpt: string): Promise<ExcerptMatchResult> => {
    if (!excerpt || !text) {
      const empty = missResult(NO_MATCH);
      resolved.onMiss?.(excerpt, NO_MATCH);
      return empty;
    }
    // 同步层：T0–T3（含 fallbacks —— T3 与自定义语义匹配器都在这里）
    let r = index.locate(excerpt);
    if (!isHit(r) && resolved.retriever) {
      // T4：召回给粗位置，段内确定性对齐给精确坐标
      const semantic = await locateSemantic(index, excerpt, resolved.retriever, {
        aligner: resolved.aligner,
        minAlignScore: resolved.minScore,
        checkPolarity: resolved.match.checkPolarity,
        negationLexicon: resolved.match.negationLexicon,
      });
      if (isHit(semantic) && semantic.score >= resolved.minScore) r = semantic;
    }
    const result = toResult(text, r, resolved);
    if (result.found) resolved.onHit?.(excerpt, result);
    else resolved.onMiss?.(excerpt, r);
    return result;
  };

  return { index, match };
}

/**
 * 高层入口：一条摘录，T0–T4 全档位编排，返回「结论 + 可引用原文 + 完整元数据」。
 *
 * @param excerpt 摘录文本（默认视为从渲染后文档复制；来自 md 源码时设 `excerptIsMarkdown`）
 * @param text 文档内容（md 源码或纯文本）
 * @param options 匹配与编排选项，见 {@link ExcerptMatcherOptions}；全部有默认，可完全不传
 * @returns 统一结果，见 {@link ExcerptMatchResult}；未命中时 `found: false`，**从不返回 `null`**
 *
 * @remarks
 * 只查一条时用这个；同一篇文本查多条请用 {@link createExcerptMatcher} 复用索引。
 *
 * 零配置即可用：md 摊平、T3 模糊层、中文数词、的/地/得 全部内置默认；
 * 唯独 `retriever`（T4 语义召回）没有默认 —— 不传绝不碰语义层，
 * 调用方式（`await`）恒定。想收紧就按需少传：
 *
 * | 需求 | 写法 |
 * |---|---|
 * | 只要确定性结果（引用校验 / 取证） | `preset: 'strict'` |
 * | 关掉模糊层但保留分段 / 跨块 | `fallbacks: []` |
 * | 不把 md 当源码摊平 | `markdown: null` |
 *
 * @example 校验摘录出处，命中即引用
 * ```ts
 * const r = await matchExcerpt(excerpt, mdSource);
 * if (r.found) cite(r.source, r.index, r.length);
 * ```
 *
 * @example 严格场景：只走确定性分层（T0–T2）
 * ```ts
 * const r = await matchExcerpt(excerpt, mdSource, { preset: 'strict' });
 * // strict 档不允许分段锚点与跨块；r.found === true 时 kind 必为 exact / normalized，可直接引用
 * ```
 */
export async function matchExcerpt(
  excerpt: string,
  text: string,
  options: ExcerptMatcherOptions = {}
): Promise<ExcerptMatchResult> {
  return createExcerptMatcher(text, options).match(excerpt);
}
