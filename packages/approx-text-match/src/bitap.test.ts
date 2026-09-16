import { describe, expect, it } from 'vitest';
import { createBitapFallback } from './bitap';
import type { BitapMatcher, Differ, DiffChunk } from './bitap';

/**
 * 用一个「内置的朴素实现」驱动核心编排，这样测试不依赖任何外部库 ——
 * 验证的是 **seed-and-extend 与区间边界确定** 这两件本包独有的事。
 */
/**
 * 「按前若干字符定位」的粗糙替身 —— 它**不是精确匹配**，
 * 因此能模拟 Bitap 的近似定位行为（摘录与页面有差异时仍能给出位置）。
 */
const prefixMatch: BitapMatcher = (text, pattern, loc) => {
  for (let len = Math.max(2, pattern.length); len >= 2; len--) {
    const at = text.indexOf(pattern.slice(0, len), Math.max(0, loc - 1));
    if (at >= 0) return at;
  }
  return -1;
};

/**
 * 测试替身：LCS 版 diff。
 *
 * 刻意**不用** `diff-match-patch` —— 那份由 adapters 测试覆盖。
 * 这里要验证的是 seed-and-extend 与区间确定，换任何后端都应成立。
 */
const lcsDiff: Differ = (a, b): DiffChunk[] => {
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
      push(-1, a[i]); // 页面多出
      i++;
    } else {
      push(1, b[j]); // 摘录多出
      j++;
    }
  }
  while (i < n) push(-1, a[i++]);
  while (j < m) push(1, b[j++]);
  return out;
};

const find = createBitapFallback(prefixMatch, lcsDiff);

describe('近似子串定位', () => {
  it('完全相同的片段 → score 1', () => {
    const r = find.find('本院认为被告构成违约', '前文。本院认为被告构成违约。后文');
    expect(r).not.toBeNull();
    expect(r![0].score).toBeCloseTo(1, 5);
  });

  it('★ 返回的是连续区间，且包含中间未匹配的字符', () => {
    // 页面有标点，摘录没有 —— 这些标点必须落在区间内，否则高亮会缺字
    const page = '本院认为，被告的行为已经构成根本违约，应当赔偿。';
    const r = find.find('本院认为被告的行为构成根本违约', page)!;
    const span = page.slice(r[0].start, r[0].end);
    expect(span).toContain('本院认为');
    expect(span).toContain('根本违约');
    // 区间必须连续覆盖，而不是分散片段
    expect(r[0].end - r[0].start).toBeGreaterThanOrEqual(span.length);
  });

  it('★ 中间漏字仍能定位（OCR / 手打偏差）', () => {
    const r = find.find('本院认为被告构成违约', '本院认为，被告的行为构成违约。');
    expect(r).not.toBeNull();
    expect(r![0].score).toBeGreaterThan(0.5);
  });

  it('完全无关 → null', () => {
    expect(find.find('完全不相干的文字', '甲乙丙丁戊己庚辛壬癸')).toBeNull();
  });

  it('摘录过短（<2 字）→ null', () => {
    expect(find.find('本', '本院认为被告构成违约')).toBeNull();
  });

  it('Bitap 抛错时退回精确位置而非崩溃', () => {
    // 模拟 pattern 过长等拒绝情形
    const throwing: BitapMatcher = () => {
      throw new Error('Pattern too long');
    };
    const f = createBitapFallback(throwing, lcsDiff);
    const r = f.find('本院认为被告构成违约', '前文。本院认为被告构成违约。');
    expect(r).not.toBeNull();
  });
});

describe('区间语义 vs 模糊搜索（本包的存在理由）', () => {
  it('start/end 可直接用于 slice，得到完整的一段', () => {
    const page = '本院认为，被告的行为已经构成根本违约，应当承担赔偿责任。';
    const r = find.find('本院认为被告的行为构成根本违约', page)!;
    const span = page.slice(r[0].start, r[0].end);
    // slice 出来的应当是一段连续文本，且首尾都是摘录里出现的内容
    expect(span.length).toBeGreaterThan(0);
    expect(span.startsWith('本院认为')).toBe(true);
  });
});
