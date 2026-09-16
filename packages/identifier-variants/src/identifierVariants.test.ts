import { describe, expect, it } from 'vitest';
import { findIdentifierBreaks, normalizeIdentifier, splitCamelCase, normalizeSeparators } from './identifierVariants';

describe('标识符变体归一', () => {
  it('各种写法收敛到同一形式', () => {
    const forms = ['TensorFlow', 'tensor_flow', 'tensor-flow', 'tensor flow'];
    const out = forms.map((s) => normalizeIdentifier(s).toLowerCase());
    expect(new Set(out).size).toBe(1);
  });

  it('★ 拆分方向而非合并：HelloWorld → Hello World', () => {
    // 合并会把普通的「Hello World」也并掉；自然文本里不会出现
    // 两个词紧贴无空格，所以「无空格 + 驼峰」才是标识符的强信号
    expect(splitCamelCase('TensorFlow')).toBe('Tensor Flow');
    expect(splitCamelCase('thecourt')).toBe('thecourt'); // 小写接小写，不触发
  });

  it('统一 _ 与各类连字符', () => {
    for (const s of ['hello_world', 'hello-world', 'hello–world']) {
      expect(normalizeSeparators(s)).toBe('hello world');
    }
  });

  it('★ 只在标识符语境内拆分，跨脚本不合并', () => {
    expect(normalizeIdentifier('北京-上海')).toBe('北京-上海'); // 汉字两侧不拆
    expect(normalizeIdentifier('URLParser')).toBe('URLParser'); // 连续大写不拆
  });

  it('findIdentifierBreaks 是共享核心：位置与类型都正确', () => {
    expect(findIdentifierBreaks('TensorFlow')).toEqual([
      { at: 6, kind: 'insert', sourceLength: 0 },
    ]);
    expect(findIdentifierBreaks('hello_world')).toEqual([
      { at: 5, kind: 'replace', sourceLength: 1 },
    ]);
  });
});
