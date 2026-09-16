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
import { spanFromNormalized, type PageIndex } from './locator';
import { detectLanguageProfile, tokenize } from './languageProfiles';

export { splitSegments };
export type { Segment, SemanticRetriever };

/**
 * 语义定位（本库坐标版）。
 *
 * @remarks
 * 与子包的差别仅在坐标：子包返回**归一化文本**的下标，
 * 这里用 `spanFromNormalized` 换算回 md 源码。
 */
export async function locateSemantic(
  index: PageIndex,
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
    ? (excerpt: string, segmentText: string) => {
        const needle = normalizeWithMap(excerpt, { ignoreCase: true, ignoreWidth: true }).text;
        if (!needle) return null;
        // 子区间复用整页的 map 切片：map 存的是原文绝对下标，切片天然安全
        const subHay: NormalizedText = {
          text: segmentText,
          map: index.norm.map,
        };
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
