import { detectNegation } from '@isdk/zh-negation';
import { splitSegments } from './splitSegments';
import type {
  LocateSemanticOptions,
  PolarityFn,
  SegmentAligner,
  SemanticContext,
  SemanticHit,
  SemanticRetriever,
} from './types';

/**
 * 两段文本极性是否冲突（一个肯定、一个否定）。
 *
 * @remarks
 * **只比奇偶，不比用词** —— 「不去」与「没去」同为否定，不算冲突。
 * 用词差异是风格问题，极性翻转才是语义问题。
 */
function conflict(a: { negated: boolean }, b: { negated: boolean }): boolean {
  return a.negated !== b.negated;
}

/**
 * 两阶段语义定位：**外部召回候选段 → 段内精确对齐**。
 *
 * ## 为什么不让模型直接吐字符下标
 *
 * LLM / embedding 返回的下标在长文里经常漂（token ≠ 字符），
 * 且不同 tokenizer 的计数口径不一。**召回只需回答"大概是这一段"，
 * 精确定位是确定性问题** —— 后者不该交给概率模型。
 *
 * ## 降级策略
 *
 * 没有 `aligner` 或段内对齐失败时，**高亮整段并降分**（×0.9），
 * 而不是返回 null。理由：召回已经说了"大概是这段"，
 * 给用户一个粗粒度的位置，比什么都不给有用。
 *
 * @param text 被搜索的完整文本
 * @param excerpt 待定位的摘录
 * @param retrieve 语义检索器（embedding / BM25 / 任意实现）
 * @param options 见 {@link LocateSemanticOptions}
 * @returns 命中位置；未命中返回 `null`
 *
 * @example
 * ```ts
 * // 检索器用 BM25 或 embedding，本包不关心实现
 * const hit = await locateSemantic(text, excerpt, myRetriever, {
 *   aligner: (ex, seg) => approxFind.find(ex, seg)?.[0] ?? null,
 * });
 * ```
 */
export async function locateSemantic(
  text: string,
  excerpt: string,
  retrieve: SemanticRetriever,
  options: LocateSemanticOptions = {}
): Promise<SemanticHit | null> {
  const topK = options.topK ?? 3;
  const minRecall = options.minRecallScore ?? 0.5;
  const minAlign = options.minAlignScore ?? 0.6;
  const aligner: SegmentAligner | undefined = options.aligner;

  const segments = splitSegments(text, options.maxSegmentLength ?? 300);
  if (segments.length === 0) return null;

  // 语言与分词器本包不探测、不使用，只透传给检索器（BM25 / 多语模型需要）
  const ctx: SemanticContext = {
    locale: options.locale,
    tokenize: options.tokenize,
  };

  // 极性守卫
  const checkPolarity = options.checkPolarity ?? true;
  const polarity: PolarityFn = options.polarity ?? ((s: string) => detectNegation(s, options.negationLexicon));
  const excerptPolarity = checkPolarity ? polarity(excerpt) : null;

  const hits = await retrieve(excerpt, segments.map((s) => s.text), ctx);
  const ranked = hits
    .filter((h) => h.score >= minRecall && segments[h.index])
    .filter((h) => !excerptPolarity || !conflict(excerptPolarity, polarity(segments[h.index].text)))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // 召回分**仅用于排序**，不参与最终 score 的数值混合。
  // 归一化只发生在 via='segment'（拿不到对齐分）时，且结果仅排序意义。
  const normalized = normalizeScores(ranked.map((h) => h.score));

  // ★ 前 topK 名**都要**尝试对齐：召回只负责排序，排第一的未必是能精确对齐的那段。
  // 只有全部对齐失败才降级 —— 因此降级必须写在循环**之后**。
  for (let rank = 0; rank < ranked.length; rank++) {
    const hit = ranked[rank];
    const seg = segments[hit.index];
    // 段起点一并交给对齐器：调用方要把它换算成整页坐标
    const aligned = tryAlignWithin(seg.text, excerpt, aligner, minAlign, seg.start);
    if (aligned) {
      return {
        start: seg.start + aligned.start,
        end: seg.start + aligned.end,
        // ★ 对齐分是唯一有绝对语义的分数，直接用它 ——
        //   不与召回分混合，因为两者量纲不同
        score: clamp01(aligned.score),
        via: 'aligned',
        segmentIndex: hit.index,
        recallRank: rank,
        recallScore: hit.score,
      };
    }
  }

  // 降级：高亮**排名最前**的那一段（rank 0），而不是最后尝试的那个。
  const top = ranked[0];
  if (!top) return null;
  const topSeg = segments[top.index];
  return {
    start: topSeg.start,
    end: topSeg.start + topSeg.text.length,
    // 无对齐分可用 → 如实给出归一化召回分（仅排序意义），
    // 并降权表示"未经精确对齐确认"
    score: clamp01(normalized[0] * SEGMENT_FALLBACK_FACTOR),
    via: 'segment',
    segmentIndex: top.index,
    recallRank: 0,
    recallScore: top.score,
  };
}

/** 降级系数：整段命中未经对齐确认，故降权表示不确定 */
const SEGMENT_FALLBACK_FACTOR = 0.9;

/**
 * 把一批召回分做 min-max 归一化到 0~1。
 *
 * @remarks
 * **BM25 用户需要这个**：BM25 的分数无上界，`minRecallScore: 0.5`
 * 这种绝对阈值对它毫无意义。本包内部用它把降级时的召回分映射到 0~1，
 * 但这**只是为了让数值落在契约区间内，不赋予它绝对语义**。
 *
 * 全部分数相同时返回全 1（而非除零）—— 此时位次才是唯一有效信息。
 */
export function normalizeScores(scores: number[]): number[] {
  if (scores.length === 0) return [];
  let min = Infinity;
  let max = -Infinity;
  for (const s of scores) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  if (!(max > min)) return scores.map(() => 1);
  return scores.map((s) => (s - min) / (max - min));
}

/**
 * 把分数钳到 0~1。
 *
 * @remarks
 * `SemanticHit.score` 的契约是 0~1，但**检索器的分数不一定有上界**
 * —— BM25 就没有。不钳制会把越界值一路带到调用方。
 */
function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/** 段内对齐：失败返回 null，由调用方决定降级策略 */
function tryAlignWithin(
  segmentText: string,
  excerpt: string,
  aligner: SegmentAligner | undefined,
  minAlign: number,
  segmentStart: number
): { start: number; end: number; score: number } | null {
  if (!aligner) return null;
  const r = aligner(excerpt, segmentText, segmentStart);
  if (!r || r.score < minAlign) return null;
  return r;
}
