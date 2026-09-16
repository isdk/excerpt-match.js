/**
 * 归一化的**属性测试** —— 不变量由随机输入验证，而不是几个手写用例。
 *
 * 为什么需要它：归一化是全库唯一"有魔法"的地方，输入空间却近乎无限
 * （转义、实体、零宽、全角、代理对、组合字符、Emoji…）。
 * 手写用例只能覆盖想到的组合，漏掉的恰好是最容易出错的那些。
 *
 * @remarks
 * 关于不变量 3（可回切）的**已知例外**：`ﬁ` → `fi` 这类 NFKC 展开会让
 * **多个输出字符共享同一个源码字符**，此时"每字符可回切"不成立。
 * 见 {@link 已知例外} 一节 —— 它是被钉死的已知行为，不是缺陷。
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { normalizeWithMap } from './normalize';
import type { NormalizeOptions } from './normalize';

/**
 * 刻意掺入的"难搞"字符。
 *
 * 不含 `\u0001`：那是流水线内部的折叠占位符，
 * 正文若真含它需先剔除（见 `normalize.ts` 顶部说明），不在不变量范围内。
 */
const TRICKY = [
  '\u200b', // 零宽空格
  '\u00ad', // 软连字符
  '\ufeff', // BOM（注意：NFKC 不删它）
  'ﬁ', // 连字 → NFKC 展开成 2 字符
  '①', // 带圈数字 → NFKC 折叠成 1
  'Ａ', // 全角 A
  '，', // 全角逗号
  '、', // 顿号（不被 NFKC 折叠，是列表分隔符）
  '。',
  '１', // 全角 1
  'é', // 预组合
  'e\u0301', // 组合字符（e + 锐音符）
  '\u{1f468}\u{200d}\u{1f469}', // ZWJ  emoji 序列（代理对）
  '\t',
  '\n',
  ' ',
  '中',
  '文',
  'A',
  'a',
  'Z',
  '1',
  ',',
  '.',
  '*',
  '\\',
  '&',
  'a',
];

/** 由难搞字符拼出的随机文本 */
const trickyText = fc
  .array(fc.constantFrom(...TRICKY), { minLength: 0, maxLength: 24 })
  .map((a) => a.join(''));

/** 任意 Unicode 文本（含代理对） */
const anyText = fc.string({ minLength: 0, maxLength: 24 });

const textGen = fc.oneof(trickyText, anyText);

const optionsGen: fc.Arbitrary<NormalizeOptions> = fc.record({
  ignoreCase: fc.boolean(),
  ignorePunctuation: fc.boolean(),
  ignoreWidth: fc.boolean(),
  dropSpaceBetweenCJK: fc.boolean(),
  numberGrouping: fc.boolean(),
  groupingUnderscore: fc.boolean(),
  splitCamelCase: fc.boolean(),
  normalizeIdentifierSeparators: fc.boolean(),
});

describe('不变量 1：幂等', () => {
  it('★ normalize(normalize(x)) === normalize(x)', () => {
    fc.assert(
      fc.property(textGen, optionsGen, (src, opts) => {
        const once = normalizeWithMap(src, opts);
        // 幂等必须在**同一种选项**下验证：换选项就是在问另一个问题
        const twice = normalizeWithMap(once.text, opts);
        expect(twice.text).toBe(once.text);
      }),
      { numRuns: 400 }
    );
  });
});

describe('不变量 2：map 单调不减，且带末尾哨兵', () => {
  it('★ map 单调不减', () => {
    fc.assert(
      fc.property(textGen, optionsGen, (src, opts) => {
        const r = normalizeWithMap(src, opts);
        for (let i = 1; i < r.map.length; i++) {
          expect(r.map[i]).toBeGreaterThanOrEqual(r.map[i - 1]);
        }
      }),
      { numRuns: 400 }
    );
  });

  it('★ map.length === text.length + 1（末尾哨兵保证 map[len] 恒有定义）', () => {
    fc.assert(
      fc.property(textGen, optionsGen, (src, opts) => {
        const r = normalizeWithMap(src, opts);
        expect(r.map.length).toBe(r.text.length + 1);
        expect(r.mapEnd?.length ?? r.map.length).toBe(r.text.length + 1);
      }),
      { numRuns: 400 }
    );
  });

  it('★ 下标不会越界到源码之外', () => {
    fc.assert(
      fc.property(textGen, optionsGen, (src, opts) => {
        const r = normalizeWithMap(src, opts);
        const end = r.mapEnd ?? r.map;
        for (let i = 0; i < r.map.length; i++) {
          expect(r.map[i]).toBeGreaterThanOrEqual(0);
          expect(r.map[i]).toBeLessThanOrEqual(src.length);
          expect(end[i]).toBeGreaterThanOrEqual(r.map[i]);
          expect(end[i]).toBeLessThanOrEqual(src.length);
        }
      }),
      { numRuns: 400 }
    );
  });
});

describe('不变量 3：整段可回切', () => {
  it('★ src.slice(map[0], mapEnd[len-1]) 归一化后 === text', () => {
    fc.assert(
      fc.property(textGen, optionsGen, (src, opts) => {
        const r = normalizeWithMap(src, opts);
        if (r.text.length === 0) return; // 空文本无从回切
        const end = r.mapEnd ?? r.map;
        const slice = src.slice(r.map[0], end[r.text.length - 1]);
        expect(normalizeWithMap(slice, opts).text).toBe(r.text);
      }),
      { numRuns: 400 }
    );
  });
});

/**
 * 已知例外：NFKC 展开（1 个源码字符 → 多个输出字符）。
 *
 * `ﬁ` → `fi` 时两个输出字符**共享**同一个源码区间，于是
 * "第 i 个归一化字符恰好回切到它自己"不再成立 —— 单个字符会回切到
 * 整个展开（这是保守行为：宁可多切，不可切漏）。
 *
 * 因此不变量 3 只对**整段**与**对齐到展开边界的子段**成立。
 * 这里把它钉死，避免后人误以为是可以"修好"的 bug。
 */
describe('已知例外：NFKC 展开使「每字符可回切」不成立', () => {
  it('★ ﬁ → fi：两个输出字符指向同一个源码区间', () => {
    const r = normalizeWithMap('ﬁ');
    expect(r.text).toBe('fi');
    expect(r.map[0]).toBe(0);
    expect(r.map[1]).toBe(0); // 共享起点，这就是例外的根源
    expect(r.mapEnd![0]).toBe(r.mapEnd![1]);
  });

  it('★ 但整段仍然可回切（不变量 3 的整段形式不受影响）', () => {
    const r = normalizeWithMap('aﬁb');
    expect(r.text).toBe('afib');
    const end = r.mapEnd ?? r.map;
    expect(normalizeWithMap('aﬁb'.slice(r.map[0], end[r.text.length - 1])).text).toBe(r.text);
  });

  it('★ 只切半个展开时，回切结果会"多切" —— 这正是保守行为的代价', () => {
    const r = normalizeWithMap('ﬁ');
    // 取第 0 个字符 'f' 的源码区间，切片仍是整个 'ﬁ'
    const slice = 'ﬁ'.slice(r.map[0], r.mapEnd![0]);
    expect(slice).toBe('ﬁ');
    expect(normalizeWithMap(slice).text).toBe('fi'); // ≠ 'f'
  });
});

describe('不变量 4：不做无谓的长度膨胀', () => {
  it('★ 归一化后的文本不会比原文更长（除了 NFKC 展开这类受控情况）', () => {
    fc.assert(
      fc.property(textGen, optionsGen, (src, opts) => {
        const r = normalizeWithMap(src, opts);
        // 展开（ﬁ→fi、① →1 不膨胀）最多让长度翻倍量级；这里只守住"不会失控膨胀"
        expect(r.text.length).toBeLessThanOrEqual(Math.max(src.length * 2, 8));
      }),
      { numRuns: 400 }
    );
  });

  it('★ 纯 ASCII 且无特殊选项时，归一化不增删字符（只改形态）', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9]+$/),
        (src) => {
          const r = normalizeWithMap(src, {
            ignoreCase: true,
            ignorePunctuation: false,
            ignoreWidth: true,
            dropSpaceBetweenCJK: false,
          });
          expect(r.text.length).toBe(src.length);
        }
      ),
      { numRuns: 200 }
    );
  });
});
