import { describe, it, expect } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { diff_match_patch } from 'diff-match-patch';
import {
  locateExcerpt,
  createTextIndex,
  normalizeWithMap,
  isHit,
  createDmpFallback,
  createMdastFlattener,
  regexFlattener,
} from './index';

const md = createMdastFlattener(fromMarkdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
});
const fuzzy = createDmpFallback(new diff_match_patch());

const DOC = [
  '---',
  'title: 民事判决书',
  '---',
  '',
  '# 重庆市渝中区人民法院',
  '',
  '本院认为，**被告**的行为已经构成[根本违约](http://a.b/c)，应当承担违约责任。',
  '',
  '> 依照《中华人民共和国民法典》第五百七十七条之规定。',
  '',
  '| 甲方 | 乙方 |',
  '| --- | --- |',
  '| 张三 | 李四 |',
  '',
  '- 第一项：继续履行',
  '- 第二项：赔偿损失',
  '',
  '![现场照片](photo.png)以上事实，有合同原件为证。',
  '',
  '<!-- 转换工具注释 -->',
].join('\n');

describe('摊平：md 源码 → 渲染后可见文本', () => {
  it('语法标记消失，可见文本保留', () => {
    const idx = createTextIndex(DOC, { markdown: md });
    for (const noise of ['**', '](http', '|---|', '<!--', '![', '# ', '> ']) {
      expect(idx.text).not.toContain(noise);
    }
    expect(idx.text).toContain('被告');
    expect(idx.text).toContain('张三');
  });

  it('图片 alt 不进文本（渲染成 <img>，用户复制不到）', () => {
    const idx = createTextIndex(DOC, { markdown: md });
    expect(idx.text).not.toContain('现场照片');
    expect(idx.text).toContain('以上事实');
  });

  it('块级切片可用于语义召回', () => {
    const idx = createTextIndex(DOC, { markdown: md });
    expect(idx.blocks.length).toBeGreaterThanOrEqual(5);
  });
});

describe('摘录来自渲染后页面', () => {
  it('纯文本摘录命中含标记的源码段落', () => {
    const ex = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const r = locateExcerpt(ex, DOC, { markdown: md });
    expect(isHit(r)).toBe(true);
    expect(r.score).toBe(1);
    const span = DOC.slice(r.index, r.index + r.length);
    expect(span).toContain('**被告**');
    expect(span).toContain('http://a.b/c');
  });

  it('span 补齐全标记，不切在标记中间', () => {
    const r = locateExcerpt('被告', DOC, { markdown: md });
    expect(DOC.slice(r.index, r.index + r.length)).toBe('**被告**');
  });

  it('表格：摘录「张三 李四」能命中 | 张三 | 李四 |', () => {
    const r = locateExcerpt('张三 李四', DOC, { markdown: md });
    expect(isHit(r)).toBe(true);
    const span = DOC.slice(r.index, r.index + r.length);
    expect(span).toContain('张三');
    expect(span).toContain('李四');
  });

  it('引用块、标题、列表项', () => {
    expect(isHit(locateExcerpt('重庆市渝中区人民法院', DOC, { markdown: md }))).toBe(true);
    expect(isHit(locateExcerpt('依照《中华人民共和国民法典》第五百七十七条之规定。', DOC, { markdown: md }))).toBe(true);
    expect(isHit(locateExcerpt('第一项：继续履行', DOC, { markdown: md }))).toBe(true);
  });
});

describe('精确性：转义与实体', () => {
  it('转义 \\* → *', () => {
    const src = '本院认为\\*被告\\*构成违约。';
    expect(md.flatten(src).text.trim()).toBe('本院认为*被告*构成违约。');
    const r = locateExcerpt('被告*构成违约', src, { markdown: md });
    expect(isHit(r)).toBe(true);
  });

  it('实体 &amp; → &：span 必须整体包含实体', () => {
    const src = '甲方&amp;乙方签订本合同。';
    const r = locateExcerpt('甲方&乙方', src, { markdown: md });
    expect(isHit(r)).toBe(true);
    expect(src.slice(r.index, r.index + r.length)).toContain('&amp;');
  });

  it('length 是源码长度（含标记），大于渲染后字数', () => {
    const r = locateExcerpt('被告的行为已经构成根本违约', DOC, { markdown: md });
    const span = DOC.slice(r.index, r.index + r.length);
    expect(span.length).toBe(r.length);
    expect(r.length).toBeGreaterThan('被告的行为已经构成根本违约'.length);
  });
});

describe('跨块摘录', () => {
  const D2 = ['# 标题', '', '第一段末尾内容。', '', '第二段开头内容，继续往下说。', '', '第三段收尾内容。'].join('\n');

  const cases: Array<[string, string, boolean]> = [
    ['不带换行', '第一段末尾内容。第二段开头内容', true],
    ['带空格', '第一段末尾内容。 第二段开头内容', true],
    ['带换行', '第一段末尾内容。\n第二段开头内容', true],
    ['跨三段', '第一段末尾内容。第二段开头内容，继续往下说。第三段收尾内容。', true],
    ['段内不跨块', '第二段开头内容，继续往下说。', false],
  ];

  for (const [name, ex, cross] of cases) {
    it('跨块：' + name, () => {
      const r = locateExcerpt(ex, D2, { markdown: md });
      expect(isHit(r)).toBe(true);
      expect(!!r.crossesBlocks).toBe(cross);
      const strip = (x: string) => normalizeWithMap(x).text.replace(/[\u0001\s]+/g, '');
      expect(strip(md.flatten(D2.slice(r.index, r.index + r.length)).text)).toContain(strip(ex));
    });
  }

  it('跨块 + 错字：模糊层也要能跨块', () => {
    const r = locateExcerpt('第一段末尾内容。第二段开头内客', D2, { markdown: md, fallbacks: [fuzzy], minFallbackScore: 0.7 });
    expect(isHit(r)).toBe(true);
    expect(r.score).toBeGreaterThan(0.8);
  });

  it('取第一个：甲\\n\\n乙', () => {
    const many = '甲\n\n乙\n\n甲\n\n乙\n\n甲\n\n乙';
    const r = locateExcerpt('甲乙', many, { markdown: md });
    expect(r.index).toBe(0);
    expect(many.slice(r.index, r.index + r.length)).toBe('甲\n\n乙');
    expect(r.occurrences).toBeGreaterThanOrEqual(2);
  });

  it('顺序：后面的字面匹配不能压过前面的跨块匹配', () => {
    const doc = '甲\n\n乙\n\n后面段落里字面出现了甲乙两字。';
    const r = locateExcerpt('甲乙', doc, { markdown: md });
    expect(r.index).toBe(0);
    expect(doc.slice(r.index, r.index + r.length)).toBe('甲\n\n乙');
  });

  it('不跳过：隔了一整段的摘录不匹配', () => {
    expect(locateExcerpt('甲乙', '甲\n\n中间整段内容\n\n乙', { markdown: md }).kind).toBe('none');
  });

  it('maxCrossBlocks: 2 → 允许跨两段，拒绝跨三段', () => {
    const doc = '甲\n\n乙\n\n丙';
    expect(isHit(locateExcerpt('甲乙', doc, { markdown: md, maxCrossBlocks: 2 }))).toBe(true);
    expect(locateExcerpt('甲乙丙', doc, { markdown: md, maxCrossBlocks: 2 }).kind).toBe('none');
  });

  it('allowCrossBlock: false → 拒绝跨块', () => {
    const ex = '第一段末尾内容。第二段开头内容';
    expect(locateExcerpt(ex, D2, { markdown: md, allowCrossBlock: false }).kind).toBe('none');
    expect(isHit(locateExcerpt(ex, D2, { markdown: md }))).toBe(true);
  });
});

describe('降级与健壮性', () => {
  it('regexFlattener 可用（不如 mdast 准）', () => {
    const simple = '# 标题\n\n本院认为，**被告**构成[违约](http://a.b)。\n\n- 第一项\n';
    expect(isHit(locateExcerpt('本院认为，被告构成违约。', simple, { markdown: regexFlattener }))).toBe(true);
  });

  it('mdast 解析失败时退化成恒等映射，不崩', () => {
    const broken = createMdastFlattener(() => {
      throw new Error('boom');
    });
    expect(isHit(locateExcerpt('随便一句话', '随便一句话在这里', { markdown: broken }))).toBe(true);
  });

  it('归一化幂等', () => {
    for (const s of ['a  b，c', 'Hello   World', '你好\n世界、中国', 'ＡＢＣ　１２３']) {
      const a = normalizeWithMap(s).text;
      expect(normalizeWithMap(a).text).toBe(a);
    }
  });
});
