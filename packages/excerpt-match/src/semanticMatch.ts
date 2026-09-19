/**
 * T4 语义层：把 `@isdk/semantic-locate` 接进本库的坐标系。
 *
 * 本文件**不实现任何检索或对齐算法**，只做坐标翻译：
 * 1. 把 `PageIndex` 的归一化文本交给子包做两阶段定位
 * 2. 把子包返回的**归一化空间偏移**换算成 md 源码坐标
 *
 * 子包刻意只处理纯字符串偏移 —— 它不需要知道归一化、md 源码、
 * 代理对这些事。职责边界与 {@link fuzzyMatch} 一致。
 *
 * @packageDocumentation
 */

import { normalizeWithMap } from '@isdk/normalize-text';
import { locateSemantic as coreLocateSemantic, splitSegments } from '@isdk/semantic-locate';
import type { Segment, SemanticRetriever } from '@isdk/semantic-locate';
import type { NegationLexicon } from '@isdk/zh-negation';
import { NO_MATCH } from './types';
import type { ExcerptMatch, FallbackMatcher, MatchContext, NormalizedText } from './types';
import { spanFromNormalized, type TextIndex } from './locator';
import { detectLanguageProfile, tokenize } from './languageProfiles';

export { splitSegments };
export type { Segment, SemanticRetriever };

/**
 * 取 {@link NormalizedText} 的一个子区间，三张映射表**一并切片**。
 *
 * @remarks
 * 切片之所以安全：`map` / `mapEnd` / `back` 存的是指向各自目标的**绝对**下标，
 * 切片只改变数组长度，不改变每个元素的含义。
 *
 * 反面教材：**把整页的 `map` 直接配给一段子文本**是错误的 ——
 * 那样 `map[0]` 会指向整页起点，段内偏移全部错位。
 * 段内对齐（`SegmentAligner`）拿到的正是这种子区间，所以必须切片。
 *
 * 长度取 `+1` 是为了保留末尾哨兵，使 `map[len]` 恒有定义
 * （与 {@link NormalizedText.map} 的契约一致）。
 */
function sliceNormalized(nt: NormalizedText, start: number, length: number): NormalizedText {
  const end = start + length;
  return {
    text: nt.text.slice(start, end),
    map: nt.map.slice(start, end + 1),
    mapEnd: nt.mapEnd?.slice(start, end + 1),
    back: nt.back?.slice(start, end + 1),
  };
}

/**
 * 语义定位（本库坐标版）。
 *
 * @remarks
 * 与子包的差别仅在坐标：子包返回**归一化文本**的下标，
 * 这里用 `spanFromNormalized` 换算回 md 源码。
 */
export async function locateSemantic(
  index: TextIndex,
  excerpt: string,
  retrieve: SemanticRetriever,
  options: {
    topK?: number;
    minRecallScore?: number;
    minAlignScore?: number;
    aligner?: FallbackMatcher;
    checkPolarity?: boolean;
    negationLexicon?: NegationLexicon;
  } = {}
): Promise<ExcerptMatch> {
  const profile = detectLanguageProfile(index.raw);
  const minAlign = options.minAlignScore ?? 0.6;
  const ctx: MatchContext = {
    locale: profile.id,
    tokenize: (t: string) => tokenize(t, profile),
    minScore: minAlign,
  };

  // 把本库的 FallbackMatcher 适配成子包要的 SegmentAligner。
  // 子包给的是**段内相对偏移**，这里要带上段的起点换算成整页偏移。
  const aligner = options.aligner
    ? (excerpt: string, segmentText: string, segmentStart = 0) => {
        // ★ 摘录必须用**与页面同一套**归一化选项，
        //   否则摘录与页面不在同一个归一化空间里，永远对不上。
        const needle = normalizeWithMap(excerpt, index.normalizeOptions).text;
        if (!needle) return null;
        const subHay = sliceNormalized(index.norm, segmentStart, segmentText.length);
        const cands = options.aligner!.find(needle, subHay, ctx);
        if (!cands) return null;
        let best = null;
        for (const c of cands) if (c.score >= minAlign && (!best || c.score > best.score)) best = c;
        return best ? { start: best.start, end: best.end, score: best.score } : null;
      }
    : undefined;

  const hit = await coreLocateSemantic(index.norm.text, excerpt, retrieve, {
    topK: options.topK,
    minRecallScore: options.minRecallScore,
    minAlignScore: minAlign,
    aligner,
    checkPolarity: options.checkPolarity,
    negationLexicon: options.negationLexicon,
    // 语言与分词器透传给检索器（BM25 / 多语模型需要）
    locale: profile.id,
    tokenize: (t: string) => tokenize(t, profile),
  });

  if (!hit) return NO_MATCH;

  const span = spanFromNormalized(index.raw, index.norm, hit.start, hit.end);
  return {
    ...span,
    kind: 'semantic',
    score: hit.score,
    occurrences: 1,
    via: hit.via === 'aligned' ? 'semantic' : 'semantic:segment',
  };
}
