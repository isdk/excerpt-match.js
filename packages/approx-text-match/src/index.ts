/**
 * `@isdk/approx-text-match` —— 近似子串定位。
 *
 * **给一段模式，在长文本里找出最相似的连续区间 + 相似度。**
 *
 * ## 和模糊搜索库的区别
 *
 * | | 模糊搜索（Fuse / fuzzysort / SymSpell） | 本包 |
 * |---|---|---|
 * | 回答 | 哪些字符匹配上了 | 命中**哪一段** |
 * | 输出 | 分散的匹配下标 | `{ start, end, score }` 连续区间 |
 * | 场景 | 候选集里挑最接近的 | 长文本里定位 |
 *
 * 前者推不出后者：模糊搜索**跳过**的不匹配字符（如标点）
 * 在区间语义里**必须被包含**，否则高亮会缺字。
 *
 * ## 不重复发明轮子
 *
 * 比对算法用现成库（推荐 `diff-match-patch-es`，因为它有 Bitap）。
 * 本包只做两件库不管的事：
 *
 * 1. **seed-and-extend** —— Bitap 对长 pattern 有上限，
 *    先从摘录里挑"在页面中出现次数最少"的种子定位，再开窗精修
 * 2. **区间边界确定** —— `match_main` **只返回起始位置不给长度**，
 *    要靠 diff 精修结束位置
 *
 * @example
 * ```ts
 * import * as dmp from 'diff-match-patch-es';
 * const find = createDmpEsFallback(dmp);
 *
 * find.find('本院认为被告构成根本违约', '本院认为，被告的行为已经构成根本违约，应当赔偿。');
 * // → [{ start: 0, end: 18, score: 0.909 }]
 * ```
 *
 * @packageDocumentation
 */

export { createBitapFallback } from './bitap';
export type {
  ApproxMatch,
  ApproxMatcher,
  BitapMatcher,
  BitapFallbackOptions,
  Differ,
  DiffChunk,
  DiffOp,
} from './bitap';

export { createDmpFallback, createDmpEsFallback } from './adapters';
export type {
  DiffMatchPatchLike,
  DmpEsLike,
  DmpEsMatchOptions,
} from './adapters';
