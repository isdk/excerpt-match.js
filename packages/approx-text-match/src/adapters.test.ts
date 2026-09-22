/**
 * 适配层的集成测试 —— 只测**真实后端**相关的事。
 *
 * @remarks
 * 分工：
 * - `bitap.test.ts` —— `createBitapFallback` 的核心编排，用 `test-doubles.ts`
 *   的朴素替身驱动，不依赖任何外部库
 * - `bitap.property.test.ts` —— `pickSeed` 与多命中的随机化契约
 * - **本文件** —— 只有"接了真库之后"才存在的东西：
 *   - 两个后端各自的集成与行为一致（Bitap 阈值、放宽重试）
 *   - legacy 后端的 `Match_*` 实例状态还原
 *   - 新参数从适配层到 `createBitapFallback` 的透传
 */

import { describe, expect, it } from 'vitest';
import { createDmpEsFallback, createDmpFallback } from './adapters';
import type { DiffMatchPatchLike } from './adapters';

/** 两个后端都是可选 peer，未安装时跳过 */
let dmpEs: unknown = null;
try {
  dmpEs = await import(/* @vite-ignore */ 'diff-match-patch-es');
} catch {
  dmpEs = null;
}

let dmpLegacyCtor: (new () => DiffMatchPatchLike) | null = null;
try {
  // 用变量而非字面量做 specifier：该包是可选 peer，缺类型声明时也不该让 tsc 报错
  const spec = 'diff-match-patch';
  const m: Record<string, unknown> = (await import(/* @vite-ignore */ spec)) as never;
  // CJS 互操作形态不一：可能在顶层，也可能挂在 default 上
  const ns = (m as { default?: Record<string, unknown> }).default ?? m;
  const Ctor = ns.diff_match_patch;
  if (typeof Ctor === 'function') dmpLegacyCtor = Ctor as new () => DiffMatchPatchLike;
} catch {
  dmpLegacyCtor = null;
}

/**
 * 均匀污染的摘录：每 3 个字插一个 `**`，使**任何** 24 字窗口都含原文不存在的字符
 * → pickSeed 所有候选 count=0 → loc 被迫退化为 0 → 触发放宽重试。
 */
function poison(text: string): string {
  return text
    .split('')
    .map((c, i) => (i > 0 && i % 3 === 0 ? '**' + c : c))
    .join('') + '**';
}

/** 把目标段落埋进文档**中后部**，制造真实的 proximity 惩罚 */
const FILLER = '本院经审理查明，双方签订的合同已经依法成立并生效。';
function bury(target: string): { doc: string; truePos: number } {
  const doc = FILLER.repeat(45) + target + FILLER.slice(0, 200);
  return { doc, truePos: doc.indexOf(target) };
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
    expect(doc.slice(r[0].start, r[0].end)).toBe('使用 TensorFlow 框架');
  });

  it('★ 默认选项即可命中 —— 不要传 threshold', () => {
    const r = find.find('人工智能在改变世界', '人工智能正在改变世界');
    expect(r).not.toBeNull();
  });

  it('完全无关 → null', () => {
    expect(find.find('完全不相干的文字', '甲乙丙丁戊己庚辛壬癸')).toBeNull();
  });

  it('★ 毒化种子（近端）：摘录混入原文不存在的标记字符仍能定位', () => {
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

  // ────────────────────────────────────────────────────────────────
  // R1③ 回归：这条用例在修复前会失败（返回 start≈59、score≈0.135）
  // ────────────────────────────────────────────────────────────────
  it('★ 毒化种子 + 远端：放宽重试必须把真实位置找回来', () => {
    const target = '甲方应当按照合同约定支付货款，逾期支付的应当支付违约金。';
    const { doc } = bury(target);
    const ex = poison(target);

    const r = find.find(ex, doc)!;
    expect(r).not.toBeNull();
    // 关键：必须落在文档后半段，而不是被 proximity 惩罚挤到开头的垃圾位置
    expect(r[0].start).toBeGreaterThan(1000);
    expect(doc.slice(r[0].start, r[0].end)).toContain('应当按照合同约定');
    // 分数不会很高：注入的 `**` 只存在于 needle、不存在于 doc，会撑大 charF1 的分母。
    // 这里只要求"明显高于噪声"（修复前的错误位置只有 0.135）。
    expect(r[0].score).toBeGreaterThan(0.5);
  });

  it('★ 毒化种子 + 远端：结果不随 threshold 变化（0.4 / 0.5 都对）', () => {
    const target = '甲方应当按照合同约定支付货款，逾期支付的应当支付违约金。';
    const { doc } = bury(target);
    const ex = poison(target);

    for (const th of [0.4, 0.5]) {
      const r = createDmpEsFallback(dmpEs as never, { threshold: th }).find(ex, doc)!;
      expect(r).not.toBeNull();
      expect(r[0].start).toBeGreaterThan(1000);
    }
  });

  // ────────────────────────────────────────────────────────────────
  // R1 结论固化：0.4 / 0.5 的差异是 accuracy 门槛，不是"es 版更敏感"
  // ────────────────────────────────────────────────────────────────
  it('★ threshold 就是 accuracy 门槛：错误率 ~0.44 时 0.4 拒、0.5 收', () => {
    const base = '甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未'; // 20 字
    const noisy = base.split('').map((c, i) => (i < 8 ? '？' : c)).join(''); // accuracy = 8/20 = 0.4…
    const d = dmpEs as unknown as { match: (t: string, p: string, l: number, o?: object) => number };
    expect(d.match(noisy, base, 0, { matchThreshold: 0.4 })).toBe(-1);
    expect(d.match(noisy, base, 0, { matchThreshold: 0.5 })).toBeGreaterThanOrEqual(0);
  });

  // ────────────────────────────────────────────────────────────────
  // R4：maxMatches / minScore 透传
  // ────────────────────────────────────────────────────────────────
  it('★ 默认只返回 1 个（兼容性）', () => {
    const target = '甲方应当按照合同约定支付货款';
    const doc = [FILLER, target, FILLER, target, FILLER].join('');
    expect(find.find(target, doc)).toHaveLength(1);
  });

  it('★ maxMatches 透传到 createBitapFallback', () => {
    const target = '甲方应当按照合同约定支付货款，逾期应当支付违约金';
    const doc = [FILLER, target, FILLER, target, FILLER, target, FILLER].join('');
    const r = createDmpEsFallback(dmpEs as never, { maxMatches: 3 }).find(target, doc)!;
    expect(r).toHaveLength(3);
    for (let i = 1; i < r.length; i++) expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
  });

  it('★ minScore 透传：低于门槛的不返回', () => {
    const target = '甲方应当按照合同约定支付货款，逾期应当支付违约金';
    const doc = [FILLER, target, FILLER, target, FILLER, target, FILLER].join('');
    const r = createDmpEsFallback(dmpEs as never, { maxMatches: 5, minScore: 0.95 }).find(target, doc)!;
    for (const m of r) expect(m.score).toBeGreaterThanOrEqual(0.95);
  });
});

describe.skipIf(!dmpLegacyCtor)('diff-match-patch（兼容保留，已停更）', () => {
  const Ctor = dmpLegacyCtor!;
  const find = createDmpFallback(new Ctor());

  it('基本定位可用', () => {
    const r = find.find('本院认为被告的行为构成根本违约', '本院认为，被告的行为已经构成根本违约。');
    expect(r).not.toBeNull();
    expect(r![0].score).toBeGreaterThan(0.8);
  });

  it('★ 毒化种子：与 dmp-es 同一条放宽重试兜底', () => {
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

  // ────────────────────────────────────────────────────────────────
  // R1③ 回归（legacy 后端同样要修）
  // ────────────────────────────────────────────────────────────────
  it('★ 毒化种子 + 远端：legacy 后端也必须找回真实位置', () => {
    const target = '甲方应当按照合同约定支付货款，逾期支付的应当支付违约金。';
    const { doc } = bury(target);
    const ex = poison(target);

    const r = find.find(ex, doc)!;
    expect(r).not.toBeNull();
    expect(r[0].start).toBeGreaterThan(1000);
    expect(doc.slice(r[0].start, r[0].end)).toContain('应当按照合同约定');
    expect(r[0].score).toBeGreaterThan(0.5);
  });

  // ────────────────────────────────────────────────────────────────
  // R2：实例状态不泄漏
  // ────────────────────────────────────────────────────────────────
  it('★ 调用后 dmp 实例的 Match_* 必须被还原（不泄漏放宽状态）', () => {
    const dmp = new Ctor();
    const savedT = (dmp.Match_Threshold = 0.33);
    const savedD = (dmp.Match_Distance = 777);
    const localFind = createDmpFallback(dmp);

    // 走一次会触发放宽重试的调用
    const target = '甲方应当按照合同约定支付货款，逾期支付的应当支付违约金。';
    const { doc } = bury(target);
    localFind.find(poison(target), doc);

    expect(dmp.Match_Threshold).toBe(savedT);
    expect(dmp.Match_Distance).toBe(savedD);
  });

  it('★ 命中路径（未触发放宽）同样还原实例状态', () => {
    const dmp = new Ctor();
    dmp.Match_Threshold = 0.42;
    dmp.Match_Distance = 555;
    createDmpFallback(dmp).find('本院认为被告的行为构成根本违约', '本院认为，被告的行为已经构成根本违约。');
    expect(dmp.Match_Threshold).toBe(0.42);
    expect(dmp.Match_Distance).toBe(555);
  });

  it('★ 未命中路径同样还原实例状态', () => {
    const dmp = new Ctor();
    dmp.Match_Threshold = 0.42;
    dmp.Match_Distance = 555;
    createDmpFallback(dmp).find('完全不相干的文字', '甲乙丙丁戊己庚辛壬癸');
    expect(dmp.Match_Threshold).toBe(0.42);
    expect(dmp.Match_Distance).toBe(555);
  });

  it('两个后端在同一用例上结果一致', () => {
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担赔偿责任。';
    const needle = '本院认为被告的行为构成根本违约';
    const es = createDmpEsFallback(dmpEs as never).find(needle, doc)!;
    const lg = createDmpFallback(new Ctor()).find(needle, doc)!;
    expect(es[0].score).toBeCloseTo(lg[0].score, 6);
  });
});

/**
 * 集成层的不变量 —— 语义层面由 bitap.test.ts 用替身覆盖，
 * 这里只确认"接上真库之后依然成立"（两个后端各验一遍）。
 */
describe('两个后端共用的不变量', () => {
  it('★ 命中区间一定连续 ── 中间未匹配的字也在区间内（区间语义）', () => {
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担赔偿责任。';
    const needle = '本院认为被告的行为构成根本违约';
    const r = createDmpEsFallback(dmpEs as never).find(needle, doc)!;
    const span = doc.slice(r[0].start, r[0].end);
    // 区间内必然包含被跳过的标点，且首尾与摘录对应
    expect(span).toContain('，');
    expect(span.startsWith('本院认为')).toBe(true);
    expect(span.endsWith('根本违约')).toBe(true);
  });

  it('★ 返回的区间下标都落在 hay 范围内', () => {
    const doc = FILLER.repeat(10) + '甲方应当按照合同约定支付货款';
    const needle = '甲方应当按照合同约定支付货款';
    const r = createDmpEsFallback(dmpEs as never).find(needle, doc)!;
    for (const m of r) {
      expect(m.start).toBeGreaterThanOrEqual(0);
      expect(m.end).toBeLessThanOrEqual(doc.length);
      expect(m.end).toBeGreaterThan(m.start);
    }
  });
});
