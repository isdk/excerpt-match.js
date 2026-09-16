import { describe, expect, it } from 'vitest';
import { stripGroupingSeparators, CHINESE_NUMERAL_CHARS, createCjkNumberParser } from './numberNotation';
import type { CjkNumberLike } from './numberNotation';

let CJK: CjkNumberLike | null = null;
try {
  CJK = (await import(/* @vite-ignore */ 'cjk-number')) as unknown as CjkNumberLike;
} catch {
  CJK = null;
}

describe('stripGroupingSeparators', () => {
  it('只删分隔符，位数不对的不动', () => {
    const s = new Set([',']);
    expect(stripGroupingSeparators('1,000', s)).toBe('1000');
    expect(stripGroupingSeparators('1,000,000', s)).toBe('1000000');
    expect(stripGroupingSeparators('1,0000', s)).toBe('1,0000'); // 四位
    expect(stripGroupingSeparators('12,34', s)).toBe('12,34'); // 两位
  });

  it('分隔符集合为空时不改动', () => {
    expect(stripGroupingSeparators('1,000', new Set())).toBe('1,000');
  });
});

describe('中文数词（cjk-number 后端）', () => {
  const parser = CJK ? createCjkNumberParser(CJK) : null;

  it.skipIf(!parser)('纯数词解析 16/16', () => {
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
    }
  });

  it.skipIf(!parser)('★ 固有歧义：三思而行 仍解析成 3（换库也解决不了）', () => {
    // 这是语言本身的歧义，不是实现缺陷。
    // 整串调库会抛错，但适配层为拿 consumed 必须分段尝试，于是「三」又被单独解析。
    const r = parser!.parse('三思而行', 0);
    expect(r).not.toBeNull();
    expect(r!.value).toBe('3');
    expect(r!.consumed).toBe(1);
  });

  it.skipIf(!parser)('预筛：不在数字字符集里的词直接返回 null', () => {
    for (const s of ['未来', '第一', '本院认为']) {
      expect(parser!.parse(s, 0)).toBeNull();
    }
  });

  it('数字字符集边界', () => {
    expect(CHINESE_NUMERAL_CHARS.has('一')).toBe(true);
    expect(CHINESE_NUMERAL_CHARS.has('未')).toBe(false);
  });
});
