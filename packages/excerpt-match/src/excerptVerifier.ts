/**
 * 摘录校验器 —— 回答「这条摘录是不是出自这一页」，并**把命中的 md 原文交回去**。
 *
 * ## 为什么不只是布尔
 *
 * 校验通过之后紧接着要做的通常是**引用**：把那一段原文展示出来、高亮它、跳转到它。
 * 只回布尔等于逼调用方再拿摘录去原文里找一遍 —— 而坐标与源码片段本来就在命中结果里。
 * 所以 `verifyExcerptFromPage` 返回 {@link ExcerptVerification}：
 * `found` 是那个布尔，`source` 是可直接引用的源码片段。
 *
 * ## 相对「`toLowerCase + includes` 再自己切省略号」补上了什么
 *
 * | 差异类型 | 手搓版 | 本库 |
 * |---|---|---|
 * | 全半角 / 大小写 / 零宽 | 只处理小写与空白 | NFKC + 宽度折叠 + 零宽剔除 |
 * | md 源码里的 `**`、`[](url)`、反引号 | 当成字面字符 → 漏判 | 摊平后比对，坐标回切到源码 |
 * | 跨段复制丢换行 | 漏判 | 跨块视图接住 |
 * | 跨标点差异（`：` vs `。`） | 漏判 | `ignorePunctuation` 按需跨界 |
 * | 省略号的多种写法 | 只认 `.{3}` 与 `…` | `DEFAULT_ELLIPSIS`（`。。。`、`〔略〕`、`[…]`…） |
 * | 省略片段的**顺序与相邻性** | 不校验 → 片段散落全篇也算通过（**假命中**） | 链式锚点，必须按原文顺序 |
 * | 标题词注入 / 跨小节归纳 | 不可能 | T4 外部召回（`retriever`） |
 *
 * ## 为什么是异步
 *
 * T4 的召回器允许返回 Promise（embedding / 云 API），只要用得上语义层就只能异步。
 * T0–T3 本身是同步的 —— 索引建好后 `verify()` 不返回 Promise。
 *
 * @packageDocumentation
 */

import { createTextIndex } from './locator';
import { locateSemantic } from './semanticMatch';
import type { TextIndex } from './locator';
import type { SemanticRetriever } from './semanticMatch';
import type { ExcerptMatch, FallbackMatcher, MatchKind, MatchOptions } from './types';
import { NO_MATCH, isHit } from './types';

export interface ExcerptVerifierOptions extends MatchOptions {
  /**
   * T4 的外部召回器（embedding / BM25 …）。**给了它才会走语义层**，
   * 本包不自带任何召回实现 —— 那是另一个领域。
   */
  retriever?: SemanticRetriever;
  /** T4 的段内再对齐器（如 `createDmpFallback`）；不传则退化为高亮整段并降分 */
  aligner?: FallbackMatcher;
  /**
   * T3 / T4 命中的最低可接受置信度。
   *
   * @remarks
   * T0–T2 恒为 1，不受它约束 —— 只有近似层与语义层受门槛管辖。
   * @defaultValue `options.minFallbackScore ?? 0.75`
   */
  minScore?: number;
  /** 未命中时的回调；默认 `console.warn` */
  onMiss?: (excerpt: string, result: ExcerptMatch) => void;
}

/** 校验结果：是否出自该页 + 命中的原文，可直接用于引用与高亮 */
export interface ExcerptVerification {
  /** 是否出自该页 —— 旧函数返回的那个布尔就在这 */
  found: boolean;
  /**
   * 命中的 **md 源码片段**，等价于 `pageContent.slice(index, index + length)`。
   *
   * @remarks
   * md 模式下它**含语法标记**（`**`、`[](url)`、反引号）—— 引用该引的是源码，
   * 而不是渲染后文本；未命中为空串。
   */
  source: string;
  /** 渲染后可见文本（剥掉语法标记），便于展示；未命中为空串 */
  text: string;
  /** 命中层级：exact / normalized / segmented / fuzzy / semantic */
  kind: MatchKind;
  /** 置信度 0–1；T0–T2 恒为 1 */
  score: number;
  /** 源码起始下标；未命中为 -1 */
  index: number;
  /** 源码片段长度；未命中为 0 */
  length: number;
  /** 1-based 行号；未命中为 -1 */
  line: number;
  /** 命中来自哪个 fallback（T3/T4） */
  via?: string;
  /** 是否跨越了多个块 */
  crossesBlocks?: boolean;
}

export interface ExcerptVerifier {
  /** 预建好的索引 —— 同一页校验多条摘录时复用它，别每条重建 */
  index: TextIndex;
  /** 同步校验：走 T0–T3 */
  verify(excerpt: string): ExcerptMatch;
  /** 异步校验：走 T0–T4（T4 仅在给了 `retriever` 时才发生） */
  verifyAsync(excerpt: string): Promise<ExcerptMatch>;
  /** 校验并取出原文（含未命中回调） */
  check(excerpt: string): Promise<ExcerptVerification>;
}

/** 剥离本模块自己的选项，剩下原样交给 `createTextIndex` */
function matchSubset(o: ExcerptVerifierOptions): MatchOptions {
  const { retriever, aligner, minScore, onMiss, ...rest } = o;
  void retriever; void aligner; void minScore; void onMiss;
  return rest;
}

function minScoreOf(o: ExcerptVerifierOptions): number {
  return o.minScore ?? o.minFallbackScore ?? 0.75;
}

function lineOf(pageContent: string, index: number): number {
  if (index < 0) return -1;
  let line = 1;
  for (let i = 0; i < index; i++) if (pageContent[i] === '\n') line++;
  return line;
}

/**
 * 把命中换算成「原文 + 元数据」。
 *
 * @remarks
 * `source` 直接切片源码 —— 它是**唯一可作为引用依据**的字段：
 * md 模式下坐标本来就落在源码上（见 README「坐标契约」），切出来的就是作者写的那一段。
 */
function toVerification(
  pageContent: string,
  r: ExcerptMatch,
  options: ExcerptVerifierOptions
): ExcerptVerification {
  if (!(isHit(r) && r.score >= minScoreOf(options))) {
    return {
      found: false,
      source: '',
      text: '',
      kind: 'none',
      score: r.score,
      index: -1,
      length: 0,
      line: -1,
    };
  }
  const source = pageContent.slice(r.index, r.index + r.length);
  // 可见文本：只对片段单独摊平，用于展示 —— 引用请用 source
  let text = source;
  if (options.markdown) {
    try {
      // 单块片段摊平后尾部会带块分隔符换行 —— 展示用文本去掉它，source 保持原样
      text = options.markdown.flatten(source).text.replace(/\s+$/, '');
    } catch {
      text = source; // 片段本身可能是半截标记，摊平失败就退回源码
    }
  }
  return {
    found: true,
    source,
    text,
    kind: r.kind,
    score: r.score,
    index: r.index,
    length: r.length,
    line: lineOf(pageContent, r.index),
    via: r.via,
    crossesBlocks: r.crossesBlocks,
  };
}

/**
 * 建校验器 —— **同一页面对多条摘录时用这个**，索引只建一次。
 *
 * @remarks
 * 整页归一化（含 md 摊平）是 O(n) 的重活：实测 600KB 页面单次 ~200ms，复用索引后 ~7ms。
 *
 * @example
 * ```ts
 * const v = createExcerptVerifier(mdSource, { markdown: md, retriever });
 * for (const it of items) {
 *   const r = await v.check(it.excerpt);
 *   if (r.found) cite(r.source);   // 引用 md 源码片段
 * }
 * ```
 */
export function createExcerptVerifier(
  pageContent: string,
  options: ExcerptVerifierOptions = {}
): ExcerptVerifier {
  const index = createTextIndex(pageContent, matchSubset(options));

  const verify = (excerpt: string): ExcerptMatch => {
    if (!excerpt || !pageContent) return NO_MATCH;
    return index.locate(excerpt);
  };

  const verifyAsync = async (excerpt: string): Promise<ExcerptMatch> => {
    if (!excerpt || !pageContent) return NO_MATCH;
    const hit = verify(excerpt);
    if (isHit(hit)) return hit;                       // T0–T3 已够，不必动用召回
    if (!options.retriever) return hit;
    // T4：召回给粗位置，段内确定性对齐给精确坐标
    const semantic = await locateSemantic(index, excerpt, options.retriever, {
      aligner: options.aligner,
      minAlignScore: minScoreOf(options),
      checkPolarity: options.checkPolarity,
      negationLexicon: options.negationLexicon,
    });
    return isHit(semantic) && semantic.score >= minScoreOf(options) ? semantic : hit;
  };

  const check = async (excerpt: string): Promise<ExcerptVerification> => {
    const r = await verifyAsync(excerpt);
    const result = toVerification(pageContent, r, options);
    if (!result.found) {
      const onMiss = options.onMiss ?? defaultOnMiss;
      onMiss(excerpt, r);
    }
    return result;
  };

  return { index, verify, verifyAsync, check };
}

function defaultOnMiss(excerpt: string): void {
  console.warn('verifyExcerptFromPage: excerpt is not in page content:', '"' + excerpt + '"');
}

/**
 * 校验摘录是否出自该页；命中时**返回 md 原文片段**。
 *
 * @remarks
 * 只需校验一条时用这个；一页对多条请用 {@link createExcerptVerifier} 复用索引。
 *
 * @example
 * ```ts
 * const r = await verifyExcerptFromPage(excerpt, mdSource, {
 *   markdown: md,
 *   retriever,                        // 可选：需要 T4 时给
 *   aligner: createDmpFallback(dmp),  // 可选：段内再对齐
 * });
 * if (r.found) cite(r.source, r.index, r.length);
 * ```
 */
export async function verifyExcerptFromPage(
  excerpt: string,
  pageContent: string,
  options: ExcerptVerifierOptions = {}
): Promise<ExcerptVerification> {
  return createExcerptVerifier(pageContent, options).check(excerpt);
}

/**
 * 只要坐标与完整元数据的版本（不切片、不做展示用摊平）。
 *
 * @returns 统一形状的 {@link ExcerptMatch}；未命中为 `NO_MATCH`
 */
export async function locateExcerptFromPage(
  excerpt: string,
  pageContent: string,
  options: ExcerptVerifierOptions = {}
): Promise<ExcerptMatch> {
  return createExcerptVerifier(pageContent, options).verifyAsync(excerpt);
}
