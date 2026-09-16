import { describe, expect, it } from 'vitest';
import { snapToGraphemeBoundary, countGraphemes } from './grapheme';

describe('snapToGraphemeBoundary', () => {
  it('★ ZWJ 家庭 emoji 是一个字形簇', () => {
    // 👨‍👩‍👧‍👦 = 11 个 UTF-16 码元，但只是 1 个字形簇
    const r = snapToGraphemeBoundary('a👨\u200d👩\u200d👧\u200d👦b', 2, 1);
    expect(r.length).toBe(11);
  });

  it('负值下标先夹紧再算终点（回归）', () => {
    // 原先：先夹起点后，终点仍按原起点算 → 返回长度 0
    const r = snapToGraphemeBoundary('abc', -5, 2);
    expect(r.length).toBeGreaterThan(0);
  });
});

describe('countGraphemes', () => {
  it('按字形簇计数，不是码元', () => {
    expect(countGraphemes('abc')).toBe(3);
    expect(countGraphemes('👨\u200d👩\u200d👧\u200d👦')).toBe(1);
  });
});
