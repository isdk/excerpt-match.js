/**
 * `@isdk/semantic-locate` —— 两阶段语义定位。
 *
 * ## 它解决什么
 *
 * 语义检索（embedding / BM25）能告诉你"大概是这一段"，
 * 但**给不出精确的字符下标** —— 而高亮、引用、diff 都需要下标。
 *
 * 直接让模型吐下标呢？**不行**：LLM / embedding 返回的下标在长文里经常漂
 * （token ≠ 字符），不同 tokenizer 口径还不一致。
 *
 * 所以本包把它拆成两段：
 *
 * ```
 * 外部召回（embedding / BM25）→ 只知道"大概是这一段"
 *         ↓
 * 段内再对齐（approx-text-match）→ 精确到字符下标
 * ```
 *
 * **召回只需回答"哪一段"，精确定位是确定性问题。**
 *
 * ## 本包不做的事
 *
 * - **不算向量** —— 那是 embedding 库 / 云 API 的事，注入 `retrieve` 即可
 * - **不做段内对齐算法** —— 用 `@isdk/approx-text-match`
 * - **不碰坐标系** —— 只返回纯字符串偏移，调用方自行换算
 *
 * @example
 * ```ts
 * import { locateSemantic } from '@isdk/semantic-locate';
 *
 * const hit = await locateSemantic(page, excerpt, myRetriever, {
 *   aligner: (ex, seg) => approxFind.find(ex, seg)?.[0] ?? null,
 *   checkPolarity: true,
 * });
 * // → { start: 120, end: 158, score: 0.87, via: 'aligned' }
 * ```
 *
 * @packageDocumentation
 */

export { locateSemantic, normalizeScores } from './locateSemantic';
export { splitSegments } from './splitSegments';
export type { Segment } from './splitSegments';
export type {
  SemanticHit,
  SemanticRetriever,
  SemanticContext,
  SegmentAligner,
  PolarityFn,
  LocateSemanticOptions,
} from './types';
