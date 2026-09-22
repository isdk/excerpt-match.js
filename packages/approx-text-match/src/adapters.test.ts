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
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担赔偿责任。';
    const r = find.find('本院认为被告的行为构成根本违约', doc);
    expect(r).not.toBeNull();
    expect(r![0].score).toBeGreaterThan(0.8);
  });

  it('★ 区间连续且可直接 slice', () => {
    const doc = '使用 TensorFlow 框架';
    const r = find.find('使用TensorFlow框架', doc)!;
    const span = doc.slice(r[0].start, r[0].end);
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

  it('★ 毒化种子：摘录混入原文不存在的标记字符仍能定位', () => {
    // 摘录来自 md 源码（带 **）、列表序号又被压平成连写的「1. 2. 3.」，
    // 而摊平器把文档的列表序号丢掉了 → 每个种子窗口都含原文不存在的字符
    // （count=0）→ loc 被迫退化为 0 → bitap 的 proximity 惩罚压过默认阈值。
    // 适配层的放宽重试必须把它救回来（见 createDmpEsFallback）。
    const doc =
      'React 18 引入了以下几个核心特性：\n' +
      '自动批处理（Automatic Batching）\n' +
      '并发渲染（Concurrent Rendering）\n' +
      '新的根 API（New Root API）\n' +
      'Suspense 的改进\n' +
      '新的 Hooks：useId、useSyncExternalStore、useInsertionEffect';
    const ex =
      'React 18 引入了以下几个核心特性：1. **自动批处理（Automatic Batching）**' +
      '2. **并发渲染（Concurrent Rendering）**3. **新的根 API（New Root API）**' +
      '4. **Suspense 的改进**5. **新的 Hooks：useId、useSyncExternalStore、useInsertionEffect**';
    const r = find.find(ex, doc);
    expect(r).not.toBeNull();
    expect(r![0].score).toBeGreaterThan(0.8);
    expect(doc.slice(r![0].start, r![0].end)).toContain('引入了以下几个核心特性');
  });
});

describe.skipIf(!dmpLegacy)('diff-match-patch（兼容保留，已停更）', () => {
  const find = createDmpFallback(dmpLegacy as never);

  it('基本定位可用', () => {
    const r = find.find('本院认为被告的行为构成根本违约', '本院认为，被告的行为已经构成根本违约。');
    expect(r).not.toBeNull();
  });

  it('★ 毒化种子：与 dmp-es 同一条放宽重试兜底', () => {
    // 同 dmp-es 那条用例：摘录带 ** 且列表序号被压平，文档侧序号被摊平器丢弃
    // → 所有种子窗口在原文中出现 0 次 → 放宽重试兜底。两个后端行为应对齐。
    const doc =
      'React 18 引入了以下几个核心特性：\n' +
      '自动批处理（Automatic Batching）\n' +
      '并发渲染（Concurrent Rendering）\n' +
      '新的根 API（New Root API）';
    const ex =
      'React 18 引入了以下几个核心特性：1. **自动批处理（Automatic Batching）**' +
      '2. **并发渲染（Concurrent Rendering）**3. **新的根 API（New Root API）**';
    const r = find.find(ex, doc);
    expect(r).not.toBeNull();
    expect(r![0].score).toBeGreaterThan(0.8);
    expect(doc.slice(r![0].start, r![0].end)).toContain('引入了以下几个核心特性');
  });
});
