/**
 * `createBitapFallback` 的单元测试 —— **不依赖任何外部库**。
 *
 * @remarks
 * 这里验证的是本包独有的两件事：**seed-and-extend** 与**区间边界确定**。
 * 驱动它们的是 `test-doubles.ts` 里的朴素替身（`prefixMatch` / `lcsDiff`），
 * 因此"换任何后端都成立"是被这个文件的存在本身证明的。
 *
 * 涉及**真实后端**的东西一律不在这里 —— 见 `adapters.test.ts`：
 * - `diff-match-patch-es` / `diff-match-patch` 的集成
 * - Bitap 阈值（threshold / distance）与放宽重试
 * - legacy 后端的 `Match_*` 实例状态还原
 *
 * 而 `pickSeed` 的随机化契约在 `bitap.property.test.ts`。
 */

import { describe, expect, it } from 'vitest';
import { createBitapFallback } from './bitap';
import type { BitapMatcher } from './bitap';
import { lcsDiff, prefixMatch } from '../test/fakes';

const find = createBitapFallback(prefixMatch, lcsDiff);
const withOpts = (o: Parameters<typeof createBitapFallback>[2]) => createBitapFallback(prefixMatch, lcsDiff, o);

describe('近似子串定位', () => {
  it('完全相同的片段 → score 1', () => {
    const r = find.find('本院认为被告构成违约', '前文。本院认为被告构成违约。后文');
    expect(r).not.toBeNull();
    expect(r![0].score).toBeCloseTo(1, 5);
  });

  it('★ 返回的是连续区间，且包含中间未匹配的字符', () => {
    // 页面有标点，摘录没有 —— 这些标点必须落在区间内，否则高亮会缺字
    const doc = '本院认为，被告的行为已经构成根本违约，应当赔偿。';
    const r = find.find('本院认为被告的行为构成根本违约', doc)!;
    const span = doc.slice(r[0].start, r[0].end);
    expect(span).toContain('本院认为');
    expect(span).toContain('根本违约');
    expect(span).toContain('，'); // 被跳过的标点也在区间内
    // 区间连续覆盖，而不是分散片段
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
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担赔偿责任。';
    const r = find.find('本院认为被告的行为构成根本违约', doc)!;
    const span = doc.slice(r[0].start, r[0].end);
    // slice 出来的应当是一段连续文本，且首尾都是摘录里出现的内容
    expect(span.length).toBeGreaterThan(0);
    expect(span.startsWith('本院认为')).toBe(true);
  });
});

describe('返回值的基本不变量', () => {
  it('★ 区间下标始终落在 hay 范围内，且 start < end', () => {
    const doc = '前文。本院认为，被告的行为已经构成根本违约。后文';
    const r = find.find('本院认为被告的行为构成根本违约', doc)!;
    for (const m of r) {
      expect(m.start).toBeGreaterThanOrEqual(0);
      expect(m.end).toBeLessThanOrEqual(doc.length);
      expect(m.end).toBeGreaterThan(m.start);
      expect(m.score).toBeGreaterThan(0);
      expect(m.score).toBeLessThanOrEqual(1);
    }
  });

  it('★ 同一输入重复调用结果一致（无跨调用状态残留）', () => {
    const doc = '前文。本院认为，被告的行为已经构成根本违约。后文';
    const needle = '本院认为被告的行为构成根本违约';
    expect(find.find(needle, doc)).toEqual(find.find(needle, doc));
  });
});

// ────────────────────────────────────────────────────────────────
// 默认值兼容性：新增参数绝不能改变既有调用方的行为
// ────────────────────────────────────────────────────────────────

const TARGET = '甲方应当按照合同约定支付货款';
const FILLER = '本院经审理查明，双方签订的合同已经依法成立并生效，本院予以确认。';

describe('默认值兼容性（maxMatches = 1 / minScore = 0）', () => {
  it('★ 默认只返回 1 个', () => {
    const doc = FILLER + TARGET + FILLER + TARGET;
    expect(find.find(TARGET, doc)).toHaveLength(1);
  });

  it('★ 不传参数 与 显式 { maxMatches: 1 } 完全等价', () => {
    const doc = FILLER + TARGET + FILLER;
    expect(find.find(TARGET, doc)).toEqual(withOpts({ maxMatches: 1 }).find(TARGET, doc));
  });

  it('★ 不传参数 与 显式 { minScore: 0 } 完全等价', () => {
    const doc = FILLER + TARGET + FILLER;
    expect(find.find(TARGET, doc)).toEqual(withOpts({ minScore: 0 }).find(TARGET, doc));
  });

  it('maxMatches 被钳到 ≥ 1（传 0 / 负数不会崩）', () => {
    const doc = FILLER + TARGET + FILLER;
    expect(withOpts({ maxMatches: 0 }).find(TARGET, doc)).toHaveLength(1);
    expect(withOpts({ maxMatches: -5 }).find(TARGET, doc)).toHaveLength(1);
  });
});

// ────────────────────────────────────────────────────────────────
// 多命中：maxMatches / minScore
// ────────────────────────────────────────────────────────────────

const LONG_TARGET = '甲方应当按照合同约定支付货款，逾期应当支付违约金';

describe('多命中（maxMatches > 1）', () => {
  const doc = [FILLER, LONG_TARGET, FILLER, LONG_TARGET, FILLER, LONG_TARGET, FILLER].join('');

  it('★ 三处出现 → 返回 3 个', () => {
    const r = withOpts({ maxMatches: 3 }).find(LONG_TARGET, doc)!;
    expect(r).not.toBeNull();
    expect(r).toHaveLength(3);
  });

  it('★ 命中区间互不重叠 —— 遮蔽确实生效了', () => {
    const r = withOpts({ maxMatches: 3 }).find(LONG_TARGET, doc)!;
    const sorted = [...r].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      expect(sorted[i].start).toBeGreaterThanOrEqual(sorted[i - 1].end);
    }
  });

  it('★ 按分数降序：out[0] 恒为最佳命中', () => {
    const r = withOpts({ maxMatches: 3 }).find(LONG_TARGET, doc)!;
    for (let i = 1; i < r.length; i++) expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
  });

  it('★ maxMatches 是硬上限，不会超出', () => {
    expect(withOpts({ maxMatches: 2 }).find(LONG_TARGET, doc)!).toHaveLength(2);
  });

  it('★ minScore 门槛：低于门槛的不返回', () => {
    const all = withOpts({ maxMatches: 5 }).find(LONG_TARGET, doc)!;
    const strict = withOpts({ maxMatches: 5, minScore: 0.95 }).find(LONG_TARGET, doc)!;
    expect(strict.length).toBeLessThanOrEqual(all.length);
    for (const m of strict) expect(m.score).toBeGreaterThanOrEqual(0.95);
  });

  it('★ minScore 过高时直接 null（没有任何命中够格）', () => {
    // 摘录**中间**漏一个字 → 窗口跨度仍是 24、common 只有 23
    // → charF1 = 2×23/(24+23) ≈ 0.979，永远够不到 0.999
    const dropped = LONG_TARGET.slice(0, 10) + LONG_TARGET.slice(11);
    const r = withOpts({ maxMatches: 5, minScore: 0.999 }).find(dropped, doc);
    expect(r).toBeNull();
    // 门槛降下来就又能命中了 —— 证明是门槛在起作用，不是别的
    expect(withOpts({ maxMatches: 5, minScore: 0.9 }).find(dropped, doc)).toHaveLength(3);
  });

  it('★ 遮蔽哨兵不会泄漏到命中内容里', () => {
    const r = withOpts({ maxMatches: 3 }).find(LONG_TARGET, doc)!;
    for (const m of r) {
      const span = doc.slice(m.start, m.end);
      expect(span.length).toBeGreaterThan(0);
      // pickSentinel 从这几个控制符里挑，它们绝不该出现在原始 hay 的切片里
      expect(span).not.toMatch(/[\u0000-\u0002\uE000]/);
    }
  });

  it('★ 遮蔽只影响定位，不影响精修 —— 命中区间切出来仍是原文', () => {
    const r = withOpts({ maxMatches: 3 }).find(LONG_TARGET, doc)!;
    for (const m of r) {
      // 若精修误用了遮蔽文本，common 会归零、分数塌到 0
      expect(m.score).toBeGreaterThan(0.5);
      expect(doc.slice(m.start, m.end)).toContain('应当按照合同约定');
    }
  });

  it('★ 高分命中在后、低分在前时，out[0] 仍是高分（钉住排序方向）', () => {
    // 属性测试里各命中分数相同，降序断言是平凡的 —— 这条用例专门补上"分数不同"的情形。
    //
    // 构造要点：needle 40 字、两处**都是**变体（各插入若干噪声字）。
    // 于是覆盖插入点(30)的采样窗口 count=0 被判为毒化、不作数，
    // 而不覆盖它的 offset=0 窗口 count=2 胜出 → loc 落在**靠前的低分处**，
    // 第一轮命中低分、第二轮才拿到靠后的高分。不排序的话 out[0] 就是低分那个。
    const GAP = '。'.repeat(80); // 必须 > slack(64)，否则窗口尾部会够到下一处
    const needle = LONG_TARGET + '并承担违约责任及全部费用赔偿责任'; // 40 字 > maxLen 24
    const AT = 30;
    const worse = needle.slice(0, AT) + '##' + needle.slice(AT); // 插 2 字 → 低分
    const better = needle.slice(0, AT) + '#' + needle.slice(AT); // 插 1 字 → 高分
    const doc = GAP + worse + GAP + better + GAP;

    const r = withOpts({ maxMatches: 2 }).find(needle, doc)!;
    expect(r).toHaveLength(2);
    expect(r[0].score).toBeGreaterThan(r[1].score);
    // 高分那处确实在文档更靠后 —— 证明不是"碰巧按位置顺序排好"
    expect(r[0].start).toBeGreaterThan(r[1].start);
    expect(doc.slice(r[0].start, r[0].end)).toBe(better);
  });

  it('摘录只出现一次时，多命中也只返回 1 个', () => {
    const single = FILLER + LONG_TARGET;
    const r = withOpts({ maxMatches: 5, minScore: 0.6 }).find(LONG_TARGET, single)!;
    expect(r).toHaveLength(1);
  });

  it('★ 多命中下重复调用结果一致', () => {
    const f = withOpts({ maxMatches: 3, minScore: 0.5 });
    expect(f.find(LONG_TARGET, doc)).toEqual(f.find(LONG_TARGET, doc));
  });
});
