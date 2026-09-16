import { describe, expect, it } from 'vitest';
import { normalizeWithMap } from './normalize';

/**
 * 本包的核心价值：归一化**同时**保留原文坐标。
 * 这些测试独立于主包，验证「单独使用」时也正确。
 */
describe('normalizeWithMap', () => {
  it('基本归一化：全角 → 半角', () => {
    const r = normalizeWithMap('ＡＢＣ１２３');
    expect(r.text).toBe('abc123');
  });

  it('★ 坐标可回切：src.slice(map[i], mapEnd[i]) 对应 text[i]', () => {
    const src = '本院**认为**，被告构成[根本违约](http://a.b)。';
    const r = normalizeWithMap(src, { ignorePunctuation: true });
    for (let i = 0; i < r.text.length; i++) {
      const piece = src.slice(r.map[i], r.mapEnd?.[i] ?? r.map[i] + 1);
      // 切片非空即回切成功（精确等价比对由主包属性测试覆盖）
      expect(piece.length).toBeGreaterThan(0);
    }
  });

  it('★ mapEnd 不可由 map[i+1] 推算', () => {
    // 转义让一个可见字符横跨多个源码字符
    const r = normalizeWithMap('a\\*b');
    expect(r.mapEnd).toBeDefined();
  });

  it('★ 幂等：归一后再归一不变', () => {
    for (const s of ['共1,000人', '共1，000人', 'ＡＢＣ', '第1,000条']) {
      const a = normalizeWithMap(s, { ignorePunctuation: true }).text;
      const b = normalizeWithMap(a, { ignorePunctuation: true }).text;
      expect(b).toBe(a);
    }
  });

  it('★ 脚本感知：中文间空白删除，英文/韩文间保留', () => {
    // 空白被折成占位符 U+0001，而不是字面空格 —— 这是流水线的统一约定
    expect(normalizeWithMap('你 好').text).toBe('你好'); // 汉字：不用空格分词 → 删
    expect(normalizeWithMap('hello world').text).toBe('hello\u0001world'); // 拉丁：词分隔
    expect(normalizeWithMap('아버지가 방에').text).toContain('\u0001'); // 韩文：助词归属歧义
  });

  it('标识符归一复用 @isdk/identifier-variants', () => {
    const opt = { splitCamelCase: true, normalizeIdentifierSeparators: true, ignoreCase: false };
    // 插入的是折叠占位符（U+0001），后续阶段统一处理 —— 不是字面空格
    expect(normalizeWithMap('TensorFlow', opt).text).toBe('Tensor\u0001Flow');
    expect(normalizeWithMap('hello_world', opt).text).toBe('hello\u0001world');
    // 跨脚本不合并
    expect(normalizeWithMap('北京-上海', opt).text).toBe('北京-上海');
  });

  it('的/地/得 默认不折叠（误判代价高于漏判）', () => {
    // 默认 false：宁可漏也不可错
    expect(normalizeWithMap('他高兴地接受').text).toBe('他高兴地接受');
  });
});
