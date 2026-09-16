import { describe, expect, it } from 'vitest';
import { createDmpEsFallback, createDmpFallback } from './adapters';

/** 两个后端都是可选 peer，未安装时跳过 */
let dmpEs: unknown = null;
try {
  dmpEs = await import(/* @vite-ignore */ 'diff-match-patch-es');
} catch {
  dmpEs = null;
}
let dmpLegacy: unknown = null;
try {
  const m = await import(/* @vite-ignore */ 'diff-match-patch');
  dmpLegacy = new (m as unknown as { diff_match_patch: new () => unknown }).diff_match_patch();
} catch {
  dmpLegacy = null;
}

describe.skipIf(!dmpEs)('diff-match-patch-es（推荐后端）', () => {
  const find = createDmpEsFallback(dmpEs as never);

  it('★ 跨过标点差异能定位', () => {
    const page = '本院认为，被告的行为已经构成根本违约，应当承担赔偿责任。';
    const r = find.find('本院认为被告的行为构成根本违约', page);
    expect(r).not.toBeNull();
    expect(r![0].score).toBeGreaterThan(0.8);
  });

  it('★ 区间连续且可直接 slice', () => {
    const page = '使用 TensorFlow 框架';
    const r = find.find('使用TensorFlow框架', page)!;
    const span = page.slice(r[0].start, r[0].end);
    expect(span).toBe('使用 TensorFlow 框架');
  });

  it('★ 默认选项即可命中 —— 不要传 threshold', () => {
    // 实测：es 版对阈值更敏感，传 {threshold: 0.4} 会让原本能命中的摘录失效
    const r = find.find('人工智能在改变世界', '人工智能正在改变世界');
    expect(r).not.toBeNull();
  });

  it('完全无关 → null', () => {
    expect(find.find('完全不相干的文字', '甲乙丙丁戊己庚辛壬癸')).toBeNull();
  });
});

describe.skipIf(!dmpLegacy)('diff-match-patch（兼容保留，已停更）', () => {
  const find = createDmpFallback(dmpLegacy as never);

  it('基本定位可用', () => {
    const r = find.find('本院认为被告的行为构成根本违约', '本院认为，被告的行为已经构成根本违约。');
    expect(r).not.toBeNull();
  });
});
