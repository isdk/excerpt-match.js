/**
 * T3 模糊层：把 `@isdk/approx-text-match` 接进本库的坐标系。
 *
 * 本文件**不实现任何比对算法**，只做两件事：
 * 1. 把 `NormalizedText` 拆成纯字符串交给子包定位
 * 2. 把子包返回的**归一化空间区间**包成本库的 `Candidate`
 *
 * 坐标回切由 locator 统一处理 —— 子包不知道（也不该知道）坐标系的存在。
 *
 * @packageDocumentation
 */

import type { ApproxMatcher } from '@isdk/approx-text-match';
import {
  createBitapFallback as coreBitapFallback,
  createDmpFallback as coreDmpFallback,
  createDmpEsFallback as coreDmpEsFallback,
} from '@isdk/approx-text-match';
import type {
  BitapMatcher,
  Differ,
  BitapFallbackOptions,
  DiffMatchPatchLike,
  DmpEsLike,
} from '@isdk/approx-text-match';
import type { Candidate, FallbackMatcher, NormalizedText } from './types';

/**
 * 把子包的「纯字符串定位器」适配成本库的 `FallbackMatcher`。
 *
 * @remarks
 * 子包刻意只处理字符串 —— 它不需要知道归一化、md 源码、代理对这些事。
 * 坐标系的翻译全部在这一层完成，职责边界清晰。
 */
function toFallbackMatcher(matcher: ApproxMatcher): FallbackMatcher {
  return {
    name: matcher.name,
    kind: 'fuzzy',
    find(needle: string, hay: NormalizedText): Candidate[] | null {
      return matcher.find(needle, hay.text);
    },
  };
}

export type { BitapMatcher, Differ, BitapFallbackOptions, ApproxMatcher };
export type { DiffMatchPatchLike, DmpEsLike };

/** 用「Bitap 定位 + diff 精修」组装一个 T3 匹配器（本库坐标版） */
export function createBitapFallback(
  match: BitapMatcher,
  diff: Differ,
  options: BitapFallbackOptions = {}
): FallbackMatcher {
  return toFallbackMatcher(coreBitapFallback(match, diff, options));
}

/** `diff-match-patch`（已停更，兼容保留） */
export function createDmpFallback(dmp: DiffMatchPatchLike): FallbackMatcher {
  return toFallbackMatcher(coreDmpFallback(dmp));
}

/** `diff-match-patch-es`（推荐，活跃维护） */
export function createDmpEsFallback(dmpEs: DmpEsLike): FallbackMatcher {
  return toFallbackMatcher(coreDmpEsFallback(dmpEs));
}

