import { describe, expect, it } from 'vitest';
import {
  canDropSpaceBetween,
  unicodeScriptOf,
  WHITESPACE_ROLE_BY_SCRIPT,
  type UnicodeScript,
} from './whitespace';

const cp = (c: string) => c.codePointAt(0)!;
/** 便捷：直接传字符 */
const canDrop = (a: string, b: string) =>
  canDropSpaceBetween(unicodeScriptOf(cp(a)), unicodeScriptOf(cp(b)));

describe('脚本感知空白', () => {
  it('跨脚本 → 空白是排版产物，可删', () => {
    expect(canDrop('用', 'T')).toBe(true); // 中文 ↔ 英文
    expect(canDrop('共', '1')).toBe(true); // 中文 ↔ 数字
  });

  it('★ 同脚本内按正字法决定', () => {
    expect(canDrop('中', '文')).toBe(true); // 汉字：不用空格分词
    expect(canDrop('あ', 'い')).toBe(true); // 假名
    expect(canDrop('a', 'b')).toBe(false); // 拉丁：空格是词分隔符
    expect(canDrop('가', '나')).toBe(false); // 韩文：助词归属歧义
    expect(canDrop('ก', 'ข')).toBe(false); // 泰文：空格表句子边界
    expect(canDrop('1', '0')).toBe(false); // 数字：1 000 ≠ 1000
  });

  it('未知文字保守处理', () => {
    const other = 'other' as UnicodeScript;
    expect(canDropSpaceBetween(other, 'han')).toBe(false);
  });

  it('文字类别判定', () => {
    expect(unicodeScriptOf(cp('中'))).toBe('han');
    expect(unicodeScriptOf(cp('あ'))).toBe('kana');
    expect(unicodeScriptOf(cp('가'))).toBe('hangul');
    expect(unicodeScriptOf(cp('A'))).toBe('latin');
    expect(unicodeScriptOf(cp('5'))).toBe('digit');
  });

  it('角色表：韩文/拉丁/数字为词分隔符，泰文为句子边界', () => {
    expect(WHITESPACE_ROLE_BY_SCRIPT.hangul).toBe('wordDelimiter');
    expect(WHITESPACE_ROLE_BY_SCRIPT.latin).toBe('wordDelimiter');
    expect(WHITESPACE_ROLE_BY_SCRIPT.thai).toBe('boundary');
    expect(WHITESPACE_ROLE_BY_SCRIPT.han).toBe('ignorable');
  });
});
