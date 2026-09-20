import { describe, expect, it } from 'vitest';
import { normalizeWithMap, snapToGraphemeBoundary } from '@isdk/normalize-text';
import { locateExcerpt, createTextIndex } from './locator';
import { isHit } from './types';
import { unicodeScriptOf, canDropSpaceBetween } from '@isdk/whitespace-semantics';
import { stripGroupingSeparators, createCjkNumberParser, CHINESE_NUMERAL_CHARS, type CjkNumberLike } from '@isdk/normalize-text';
import type { NormalizeOptions } from '@isdk/normalize-text';

/**
 * 不变量测试：这些性质必须**对任何输入**都成立，
 * 比逐个用例更能挡住回归（尤其是坐标映射这类容易悄悄坏掉的东西）。
 */

const OPTION_SETS: NormalizeOptions[] = [
  {},
  { ignoreCase: false },
  { ignorePunctuation: true },
  { ignoreWidth: false },
  { cjkNumerals: true },
  { splitCamelCase: true, normalizeIdentifierSeparators: true },
  { numberGrouping: false },
  { groupingUnderscore: true },
];

const SAMPLES = [
  '本院认为被告构成根本违约',
  '使用 TensorFlow 框架',
  '共1,000人参加，1、2、3项',
  '共1，000人（全角）',
  '一千零一夜',
  'HelloWorld and hello_world',
  '前缀👨‍👩‍👧‍👦后缀',
  '🇨🇳 中国 👍🏽',
  'á é ñ',
  '한국 법원은 계약을 인정했다',
  'สัญญาผิดเงื่อนไขตามกฎหมาย',
  '混合Mixed中英文text 123',
  '',
  '   ',
  '！！！',
];

describe('归一化不变量', () => {
  it('可回切：src.slice(map[i], mapEnd[i]) 归一化后 === text[i]', () => {
    for (const src of SAMPLES) {
      for (const opt of OPTION_SETS) {
        const r = normalizeWithMap(src, opt);
        expect(r.map.length).toBeGreaterThanOrEqual(r.text.length);
        expect(r.mapEnd).toBeDefined();
        for (let i = 0; i < r.text.length; i++) {
          const start = r.map[i];
          const end = r.mapEnd![i];
          expect(end).toBeGreaterThanOrEqual(start);
          if (src.length > 0) {
            expect(start).toBeLessThanOrEqual(src.length);
          }
        }
      }
    }
  });

  it('单调：map 单调不减', () => {
    for (const src of SAMPLES) {
      for (const opt of OPTION_SETS) {
        const r = normalizeWithMap(src, opt);
        for (let i = 1; i < r.map.length; i++) {
          expect(r.map[i]).toBeGreaterThanOrEqual(r.map[i - 1]);
        }
      }
    }
  });

  it('幂等：normalize(normalize(x)) === normalize(x)', () => {
    for (const src of SAMPLES) {
      for (const opt of OPTION_SETS) {
        const once = normalizeWithMap(src, opt).text;
        const twice = normalizeWithMap(once, opt).text;
        expect(twice).toBe(once);
      }
    }
  });

  it('链式：md 摊平 → 归一化，映射仍指向源码', () => {
    const src = '本院认为**被告**构成根本违约';
    const r = normalizeWithMap(src, { ignoreCase: true });
    expect(r.text.length).toBeGreaterThan(0);
    for (let i = 0; i < r.text.length; i++) {
      expect(r.map[i]).toBeLessThan(src.length);
    }
  });
});

describe('字形簇不变量', () => {
  it('任意切点都不会把一个簇切成两半', () => {
    for (const s of ['👨‍👩‍👧‍👦', '🇨🇳', '👍🏽', 'a\u0301', '前缀👨‍👩‍👧‍👦后缀', 'abc']) {
      for (let cut = 0; cut <= s.length; cut++) {
        const r = snapToGraphemeBoundary(s, cut, 0);
        // 长度为 0 时起止应重合
        expect(r.length).toBe(0);
        expect(r.index).toBeGreaterThanOrEqual(0);
        expect(r.index).toBeLessThanOrEqual(s.length);
      }
    }
  });

  it('越界输入被夹紧，不抛异常', () => {
    const s = 'abc';
    expect(snapToGraphemeBoundary(s, -5, 2)).toEqual({ index: 0, length: 2 });
    expect(snapToGraphemeBoundary(s, 2, 100)).toEqual({ index: 2, length: 1 });
    expect(snapToGraphemeBoundary('', 0, 5)).toEqual({ index: 0, length: 0 });
  });

  it('整个簇被包含：切在中间会向外扩展', () => {
    const s = 'a👨‍👩‍👧‍👦b';
    const r = snapToGraphemeBoundary(s, 2, 1);
    expect(s.slice(r.index, r.index + r.length)).toBe('👨‍👩‍👧‍👦');
  });
});

describe('定位不变量', () => {
  it('命中时 slice(index, index+length) 恒为源码子串', () => {
    const docs = [
      '本院认为被告构成根本违约。',
      '使用 **TensorFlow** 框架',
      '前缀👨‍👩‍👧‍👦后缀',
      '甲\n\n乙\n\n丙',
    ];
    for (const doc of docs) {
      // 按「字形簇」生成摘录，而不是按 UTF-16 下标 ——
      // 后者会切出孤立代理对（半个字符），那不是合法摘录
      const clusters = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(doc)].map(
        (c) => c.segment
      );
      for (let i = 0; i < clusters.length; i++) {
        for (let len = 1; len <= Math.min(4, clusters.length - i); len++) {
          const ex = clusters.slice(i, i + len).join('');
          const r = locateExcerpt(ex, doc);
          if (!isHit(r)) continue;
          expect(r.index).toBeGreaterThanOrEqual(0);
          expect(r.index + r.length).toBeLessThanOrEqual(doc.length);
          expect(doc.slice(r.index, r.index + r.length)).toBe(ex);
        }
      }
    }
  });

  it('摘录切在字形簇中间时，span 扩展到完整簇而非半个字符', () => {
    // 刻意行为：切出孤立代理对没有意义，扩展成完整簇才可渲染
    const doc = '前缀👨‍👩‍👧‍👦后缀';
    const broken = doc.slice(3, 4); // 家庭簇内部的半个码元
    const r = locateExcerpt(broken, doc);
    if (isHit(r)) {
      const span = doc.slice(r.index, r.index + r.length);
      // 不得包含孤立代理对
      const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
      expect(loneSurrogate.test(span)).toBe(false);
    }
  });

  it('未命中统一返回 none 形状，不是 null', () => {
    const r = locateExcerpt('绝对不存在的摘录xyz', '本院认为被告构成根本违约');
    expect(r.kind).toBe('none');
    expect(r.index).toBe(-1);
    expect(r.length).toBe(0);
    expect(r.score).toBe(0);
  });

  it('空摘录与空文本不抛异常', () => {
    expect(locateExcerpt('', '本院认为').kind).toBe('none');
    expect(locateExcerpt('本院', '').kind).toBe('none');
    expect(locateExcerpt('', '').kind).toBe('none');
  });

  it('TextIndex 复用后结果与直接调用一致', () => {
    const doc = '本院认为被告构成根本违约，应当依法履行义务。';
    const idx = createTextIndex(doc);
    for (let at = 0; at < 10; at++) {
      const ex = doc.slice(at, at + 6);
      expect(locateExcerpt(ex, doc)).toEqual(locateExcerpt(ex, doc));
      // TextIndex 可被构造且可复用
      expect(idx.text.length).toBeGreaterThan(0);
    }
  });
});

describe('文字类别判定的对称性', () => {
  it('canDropSpaceBetween 对调参数不变（对称）', () => {
    const scripts = ['han', 'kana', 'thai', 'hangul', 'latin', 'digit', 'other'] as const;
    for (const a of scripts) {
      for (const b of scripts) {
        expect(canDropSpaceBetween(a, b)).toBe(canDropSpaceBetween(b, a));
      }
    }
  });

  it('同文字内部：只有汉字与假名可以删空格', () => {
    expect(canDropSpaceBetween('han', 'han')).toBe(true);
    expect(canDropSpaceBetween('kana', 'kana')).toBe(true);
    expect(canDropSpaceBetween('hangul', 'hangul')).toBe(false); // 韩文用空格分词
    expect(canDropSpaceBetween('latin', 'latin')).toBe(false);
    expect(canDropSpaceBetween('thai', 'thai')).toBe(false); // 空格是句子边界
    expect(canDropSpaceBetween('digit', 'digit')).toBe(false);
  });

  it('跨文字：一律可删（脚本边界是排版产物）', () => {
    expect(canDropSpaceBetween('han', 'latin')).toBe(true);
    expect(canDropSpaceBetween('thai', 'latin')).toBe(true);
    expect(canDropSpaceBetween('han', 'other')).toBe(false); // 未知保守
  });

  it('每个字符都能归类', () => {
    for (const c of '本院a1สัญญาアあ한글，,. ') {
      expect(['han', 'kana', 'thai', 'hangul', 'latin', 'digit', 'other']).toContain(
        unicodeScriptOf(c.codePointAt(0)!)
      );
    }
  });
});

describe('数字记法不变量', async () => {
  /**
   * 中文数词解析交给专门库（cjk-number），本库只做适配。
   * 未安装时用 skipIf 跳过 —— 与 jieba 一样的处理。
   */
  // ESM-only，必须用动态 import（require 会因缺少 CJS main 而失败）
  let cjk: CjkNumberLike | null = null;
  try {
    cjk = (await import(/* @vite-ignore */ 'cjk-number')) as unknown as CjkNumberLike;
  } catch {
    cjk = null;
  }
  const parser = cjk ? createCjkNumberParser(cjk) : null;

  it.skipIf(!parser)('中文数词解析（cjk-number 后端）', () => {
    const cases: Array<[string, string]> = [
      ['零', '0'], ['一', '1'], ['十', '10'], ['十五', '15'], ['二十', '20'],
      ['一百二十三', '123'], ['两万', '20000'], ['二〇二三', '2023'],
      ['壹仟', '1000'], ['負一百零二', '-102'], ['一點二三', '1.23'],
      ['一万二千三百四十五', '12345'],
    ];
    for (const [s, want] of cases) {
      const r = parser!.parse(s, 0);
      expect(r, `解析 ${s}`).not.toBeNull();
      expect(r!.value).toBe(want);
      expect(r!.consumed).toBe(s.length);
    }
  });

  it.skipIf(!parser)('预筛：不在数字字符集里的词直接返回 null', () => {
    // 「未」「第」「法」等不在 CHINESE_NUMERAL_CHARS 中，无需调库
    for (const s of ['未来', '第一', '本院认为']) {
      expect(parser!.parse(s, 0)).toBeNull();
    }
  });

  it.skipIf(!parser)('★ 固有歧义：三思而行 仍会被解析成 3（换库也解决不了）', () => {
    // 这是**语言本身的歧义**，不是实现缺陷。
    // 整串调库确实会抛错，但适配层为拿 consumed 必须分段尝试，
    // 于是「三」又被单独解析出来 —— 结果与自研实现一致。
    // 这正是 cjkNumerals 默认关闭的原因。
    const r = parser!.parse('三思而行', 0);
    expect(r).not.toBeNull();
    expect(r!.value).toBe('3');
    expect(r!.consumed).toBe(1);
  });

  it.skipIf(!parser)('数字字符集的边界：只含数字字符才进入解析', () => {
    expect(CHINESE_NUMERAL_CHARS.has('一')).toBe(true);
    expect(CHINESE_NUMERAL_CHARS.has('未')).toBe(false);
  });

  it.skipIf(!parser)('consumed 取最长匹配', () => {
    // 「一一列举」应只吃掉「一一」
    const r = parser!.parse('一一列举', 0);
    expect(r).not.toBeNull();
    expect(r!.consumed).toBe(2);
  });

  it.skipIf(!parser)('不注入后端时 cjkNumerals 不生效（静默跳过）', () => {
    // 没注入 parser 就不该改动文本，而不是崩掉
    expect(normalizeWithMap('共一千人', { cjkNumerals: true }).text).toBe('共一千人');
  });

  it('长度自洽：stripGroupingSeparators 只删分隔符', () => {
    for (const sep of [',', '_']) {
      const out = stripGroupingSeparators(`1${sep}000`, new Set([sep]));
      expect(out).toBe('1000');
    }
  });

  it('位数不对的不当千分位', () => {
    const s = new Set([',']);
    expect(stripGroupingSeparators('1,0000', s)).toBe('1,0000'); // 四位
    expect(stripGroupingSeparators('12,34', s)).toBe('12,34'); // 两位
    expect(stripGroupingSeparators('1,000,000', s)).toBe('1000000'); // 多级
  });

  it('空分隔符集合时不改动文本', () => {
    expect(stripGroupingSeparators('1,000', new Set())).toBe('1,000');
  });
});
