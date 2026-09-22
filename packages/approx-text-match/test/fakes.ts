/**
 * 测试替身：不依赖任何外部库的「Bitap 定位器」与「序列比对器」。
 *
 * @remarks
 * **为什么单独成文件**：`bitap.test.ts` 与 `bitap.property.test.ts` 都要用，
 * 而 `*.test.ts` 之间互相 import 会让用例被收集两次。
 *
 * **为什么用替身而不是真库**：本包独有的是 **seed-and-extend** 与
 * **区间边界确定**这两件事，跟后端无关 —— 用朴素实现驱动，
 * 才能证明"换任何后端都成立"。真实后端的集成由 `adapters.test.ts` 覆盖。
 *
 * 刻意做得**粗糙**：`prefixMatch` 只按前若干字符定位（不是精确匹配），
 * 这样摘录与原文有差异时仍能给出位置，模拟 Bitap 的近似定位行为。
 */

import type { BitapMatcher, DiffChunk, Differ } from '../src/bitap';

/**
 * 「按前若干字符定位」的粗糙替身。
 *
 * 从完整 pattern 开始逐字缩短，第一个能 `indexOf` 到的就算命中。
 * 它**不是精确匹配**，因此能模拟 Bitap 的近似定位行为。
 */
export const prefixMatch: BitapMatcher = (text, pattern, loc) => {
  for (let len = Math.max(2, pattern.length); len >= 2; len--) {
    const at = text.indexOf(pattern.slice(0, len), Math.max(0, loc - 1));
    if (at >= 0) return at;
  }
  return -1;
};

/**
 * LCS 版 diff。
 *
 * 输出已归一化到 {@link DiffOp}：0 = 相同，-1 = 页面（hay）多出，1 = 摘录（needle）多出。
 * 相邻同 op 的片段会合并，与 dmp 的行为一致。
 */
export const lcsDiff: Differ = (a, b): DiffChunk[] => {
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: DiffChunk[] = [];
  const push = (op: DiffChunk['op'], text: string) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && last.op === op) last.text += text;
    else out.push({ op, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push(0, a[i]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(-1, a[i]); // hay 多出
      i++;
    } else {
      push(1, b[j]); // needle 多出
      j++;
    }
  }
  while (i < n) push(-1, a[i++]);
  while (j < m) push(1, b[j++]);
  return out;
};
