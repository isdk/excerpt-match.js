import { describe, expect, it } from 'vitest';
import { normalizeWithMap } from './normalize';
import { normalizeIgnorePunctuationOption, withKeep } from './ignorePunctuation';

describe('normalizeIgnorePunctuationOption：四种写法收敛成一种', () => {
  it('false / undefined → 未启用', () => {
    expect(normalizeIgnorePunctuationOption(undefined).enabled).toBe(false);
    expect(normalizeIgnorePunctuationOption(false).enabled).toBe(false);
    expect(normalizeIgnorePunctuationOption(false).pattern).toBeNull();
  });

  it("true 与 'fold' 等价：默认 \u0001 折叠 + \\p{P} 范围", () => {
    for (const input of [true, 'fold'] as const) {
      const r = normalizeIgnorePunctuationOption(input);
      expect(r.enabled).toBe(true);
      expect(r.mode).toBe('fold');
      expect(r.pattern!.test('，')).toBe(true);
      expect(r.pattern!.test('`')).toBe(false); // 反引号是 Sk，不是标点
    }
  });

  it("'drop'：占位符一律删除", () => {
    expect(normalizeIgnorePunctuationOption('drop').mode).toBe('drop');
  });

  it('{ symbols: true } 把符号类纳入范围', () => {
    const r = normalizeIgnorePunctuationOption({ symbols: true });
    expect(r.pattern!.test('`')).toBe(true);
    expect(r.pattern!.test('+')).toBe(true);
    expect(r.pattern!.test('$')).toBe(true);
  });

  it('{ extra } 点名追加字符 —— 比打开整整类 Unicode 更克制', () => {
    const r = normalizeIgnorePunctuationOption({ extra: ['*', '|'] });
    expect(r.pattern!.test('*')).toBe(true);
    expect(r.pattern!.test('|')).toBe(true);
    expect(r.pattern!.test('`')).toBe(false); // 未开 symbols，反引号仍不算
  });

  it('preserveEllipsis 默认 true', () => {
    expect(normalizeIgnorePunctuationOption(true).preserveEllipsis).toBe(true);
    expect(normalizeIgnorePunctuationOption({ preserveEllipsis: false }).preserveEllipsis).toBe(false);
  });
});

describe('withKeep：上层把省略表达并入保护区', () => {
  it('布尔写法也能被补上 keep', () => {
    const merged = withKeep(true, [/…+/]) as { keep: RegExp[]; mode?: string };
    expect(merged.keep).toHaveLength(1);
  });

  it('已有 keep 不覆盖，追加在后', () => {
    const merged = withKeep({ keep: ['--'] }, [/…+/]) as { keep: (string | RegExp)[] };
    expect(merged.keep).toHaveLength(2);
  });

  it('明确关掉保护时不再注入', () => {
    const merged = withKeep({ preserveEllipsis: false }, [/…+/]);
    expect(merged).toEqual({ preserveEllipsis: false });
  });
});

describe('归一化行为：fold vs drop vs keep', () => {
  it('drop：什么分隔符都不留 —— 连拉丁词边界一起丢', () => {
    const t = normalizeWithMap('hello world', { ignorePunctuation: 'drop' }).text;
    expect(t).toBe('helloworld');
    // fold 下同一个用例会保留占位符（拉丁词分隔有意义）
    expect(normalizeWithMap('hello world', { ignorePunctuation: 'fold' }).text).toBe('hello\u0001world');
  });

  it('keep 能在 drop 里保住词边界 —— 组合而非再加开关', () => {
    const t = normalizeWithMap('hello, world', { ignorePunctuation: { mode: 'drop', keep: [/\s+/] } }).text;
    expect(t).toBe('hello world');
  });

  it('★ 保护区里的省略表达不被折叠', () => {
    // NFKC 已把 '……' 折成 '......'；字符串型 keep 会先走同样的 NFKC，故能命中
    expect(normalizeWithMap('前……后', { ignorePunctuation: { keep: ['……'] } }).text).toBe('前......后');
    // 不保护就会被折掉（CJK 间的占位符属 ignorable）
    expect(normalizeWithMap('前……后', { ignorePunctuation: true }).text).toBe('前后');
  });

  it('正则型 keep 按原样作用于归一化后的文本 —— 要写 NFKC 形态', () => {
    expect(normalizeWithMap('前……后', { ignorePunctuation: { keep: [/\.{2,}/] } }).text).toBe('前......后');
    expect(normalizeWithMap('前……后', { ignorePunctuation: { keep: [/…+/] } }).text).toBe('前后');
  });

  it('symbols: 反引号开始参与忽略', () => {
    const src = 'a`b';
    expect(normalizeWithMap(src, { ignorePunctuation: true }).text).toBe('a`b'); // 默认：符号不折
    expect(normalizeWithMap(src, { ignorePunctuation: { symbols: true } }).text).toBe('a\u0001b');
  });
});
