import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { locateExcerpt } from './index';
import { createMdastFlattener } from '@isdk/md-flatten';
import { STRICT, DEFAULT_PRESET, LOOSE, withPreset } from './presets';

const md = createMdastFlattener(fromMarkdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
});

/** md 摊平需要可选依赖；本文件用纯文本，避免依赖未装导致失败 */
const PAGE = '本院认为，被告的行为已经构成根本违约，应当承担赔偿责任。\n\n另有一段无关内容。';

describe('withPreset 合并规则', () => {
  it('未指定 preset → 原样返回', () => {
    const o = { ignoreCase: false };
    expect(withPreset(o)).toBe(o);
  });

  it('★ 显式项覆盖预设', () => {
    const r = withPreset({ preset: 'loose', ignorePunctuation: false });
    expect(r.ignorePunctuation).toBe(false); // 覆盖了 LOOSE 的 true
    expect(r.normalizeIdentifierSeparators).toBe(true); // 未覆盖，保留预设
  });

  it('按名字取到对应预设', () => {
    expect(withPreset({ preset: 'strict' }).allowSegmented).toBe(STRICT.allowSegmented);
    expect(withPreset({ preset: 'loose' }).ignorePunctuation).toBe(LOOSE.ignorePunctuation);
  });

  it('★ 不修改入参', () => {
    const o = { preset: 'strict' as const, ignoreCase: false };
    const snapshot = { ...o };
    withPreset(o);
    expect(o).toEqual(snapshot);
  });

  it('未知 preset → 抛错（而不是静默忽略）', () => {
    expect(() => withPreset({ preset: 'bogus' as never })).toThrow(/未知 preset/);
  });
});

describe('三档语义差异', () => {
  it('★ strict 不跨块，default 跨块', () => {
    // 必须用 md 模式：跨块依赖 block 结构，纯文本没有块的边界
    const page = '第一段甲\n\n第二段乙\n\n第三段丙';
    expect(locateExcerpt('甲第二', page, { markdown: md, preset: 'strict' }).kind).toBe('none');
    expect(locateExcerpt('甲第二', page, { markdown: md, preset: 'default' }).kind).not.toBe('none');
  });

  it('★ 纯文本 CJK 下跨块会退化（段落空白被规则删掉）', () => {
    // 这是一个**符合设计**的行为，不是 bug：CJK 之间的空白（含段落换行）
    // 本来就被判为排版产物。所以想禁止跨块，必须用 md 模式。
    const page = '甲\n\n乙\n\n丙';
    expect(locateExcerpt('甲乙', page, { preset: 'strict' }).kind).not.toBe('none');
  });

  it('★ strict 不接受分段锚点（省略号）', () => {
    const page = '前段内容中间内容后段内容';
    const excerpt = '前段内容……后段内容';
    expect(locateExcerpt(excerpt, page, { preset: 'strict' }).kind).toBe('none');
    expect(locateExcerpt(excerpt, page, { preset: 'default' }).kind).not.toBe('none');
  });

  it('★ loose 忽略标点，default 不忽略', () => {
    // 摘录把逗号写成了句号
    const page = '本院认为，被告违约。';
    const excerpt = '本院认为。被告违约。';
    expect(locateExcerpt(excerpt, page, { preset: 'default' }).kind).toBe('none');
    expect(locateExcerpt(excerpt, page, { preset: 'loose' }).kind).not.toBe('none');
  });

  it('三档都保持 checkPolarity', () => {
    // 极性守卫不该因档位放宽而消失 —— 它拦的是「意思相反」而非「字面差异」
    for (const p of [STRICT, DEFAULT_PRESET, LOOSE]) {
      expect(p.checkPolarity).toBe(true);
    }
  });

  it('★ 三档都不开启 cjkNumerals（异文收敛是假命中来源）', () => {
    for (const p of [STRICT, DEFAULT_PRESET, LOOSE]) {
      expect(p.cjkNumerals).toBe(false);
    }
  });

  it('★ 三档都不折叠 的/地/得', () => {
    for (const p of [STRICT, DEFAULT_PRESET, LOOSE]) {
      expect(p.ignoreParticles).toBe(false);
    }
  });
});

describe('预设落到真实定位行为', () => {
  it('strict 能命中精确摘录', () => {
    const r = locateExcerpt('被告的行为', PAGE, { preset: 'strict' });
    expect(r.kind).toBe('exact');
    expect(PAGE.slice(r.index, r.index + r.length)).toBe('被告的行为');
  });

  it('★ preset 与显式选项组合使用', () => {
    // 用 default 档但不允许跨块（md 模式才有块边界）
    const page = '第一段甲\n\n第二段乙\n\n第三段丙';
    expect(
      locateExcerpt('甲第二', page, { markdown: md, preset: 'default', allowCrossBlock: false }).kind
    ).toBe('none');
  });

  it('preset 对 createTextIndex 同样生效', async () => {
    const { createTextIndex } = await import('./locator');
    const idx = createTextIndex(PAGE, { preset: 'strict' });
    expect(idx.locate('被告的行为').kind).toBe('exact');
  });
});
