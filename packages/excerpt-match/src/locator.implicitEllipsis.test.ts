import { describe, it, expect } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { locateExcerpt } from './index';
import { createMdastFlattener } from '@isdk/md-flatten';

const md = createMdastFlattener(fromMarkdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
});

/**
 * 隐式省略（`implicitEllipsis`）的机制与守卫。
 *
 * 被测对象是「摘录挑句子总结、省略中段却不带约定记号」这一类现实摘要。
 * 对照组（带 `〔略〕`）的行为见 `locator.ellipsisProtocol.test.ts`
 * 与 fixture `md-summary-implicit-ellipsis`。
 */
describe('隐式省略 implicitEllipsis', () => {
  const DOC = '第一章的内容比较长比较长。这一整段中间内容都被完全省略掉了。第二章的内容同样也很长很长。';

  it('★ 基础：摘要省略中段、无记号 → segmented 命中，span 含被省略的中段', () => {
    const ex = '第一章的内容比较长比较长。第二章的内容同样也很长很长。';
    const r = locateExcerpt(ex, DOC, { implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
    expect(r.score).toBe(1);
    expect(r.index).toBe(0);
    // span 含被省略的中段：摘录总结的是整个区间
    expect(DOC.slice(r.index, r.index + r.length)).toBe(DOC);
  });

  it('★ 默认关闭：不传选项时保持旧行为 → none', () => {
    const ex = '第一章的内容比较长比较长。第二章的内容同样也很长很长。';
    expect(locateExcerpt(ex, DOC).kind).toBe('none');
  });

  it('★ number 写法设定省略上限：30 字间隔可命中，10 字则拒绝', () => {
    const ex = '第一章的内容比较长比较长。第二章的内容同样也很长很长。';
    expect(locateExcerpt(ex, DOC, { implicitEllipsis: 30 }).kind).toBe('segmented');
    expect(locateExcerpt(ex, DOC, { implicitEllipsis: 10 }).kind).toBe('none');
  });

  it('★ 守卫：覆盖率下限 —— 只挑首末两句、中段全省 → none', () => {
    // 中段足够长，使命中字数 / span 字数跌破 0.25
    const longDoc = '起句很长很长很长很长。' + '中段省略了非常多非常多非常多的内容。'.repeat(4) + '末句很长很长很长很长。';
    const ex = '起句很长很长很长很长。末句很长很长很长很长。';
    expect(locateExcerpt(ex, longDoc, { implicitEllipsis: true }).kind).toBe('none');
  });

  it('★ 守卫：任一锚点在文中找不到 → none', () => {
    const ex = '第一章的内容比较长比较长。这句原文里根本没有。';
    expect(locateExcerpt(ex, DOC, { implicitEllipsis: true }).kind).toBe('none');
  });

  it('★ 守卫：锚点必须按序出现 —— 乱序锚点拼不上', () => {
    const ex = '第二章的内容同样也很长很长。第一章的内容比较长比较长。';
    expect(locateExcerpt(ex, DOC, { implicitEllipsis: true }).kind).toBe('none');
  });

  it('★ 强度门刀：小数点不切碎锚点 —— 含 3.14 的摘要仍命中', () => {
    const doc = '这个常数大约是 3.14 左右。中间这段话被完全省略掉了。最终的计算结果没有公布。';
    const ex = '这个常数大约是 3.14 左右。最终的计算结果没有公布。';
    const r = locateExcerpt(ex, doc, { implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
    expect(doc.slice(r.index, r.index + r.length)).toContain('3.14');
  });

  it('★ 强度门刀：拉丁缩写 e.g. 不切碎锚点', () => {
    const doc = 'The first paragraph is quite long indeed. This is e.g. a small note here. The middle is omitted entirely. The final paragraph wraps it up nicely.';
    const ex = 'The first paragraph is quite long indeed. This is e.g. a small note here. The final paragraph wraps it up nicely.';
    const r = locateExcerpt(ex, doc, { implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
  });

  it('★ 末尾残片过短时回并，且补回被丢弃的分隔符（否则匹配不到原文形态）', () => {
    const doc = '第一章的内容比较长比较长。被省略的中间段落内容。第二章内容同样也很长很长，短的。';
    const ex = '第一章的内容比较长比较长。第二章内容同样也很长很长，短的。';
    const r = locateExcerpt(ex, doc, { implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
    expect(doc.slice(r.index, r.index + r.length)).toBe(doc);
  });

  it('★ 分句切分带来召回：省略发生在逗号边界时，只按句末切分会漏', () => {
    const doc = '甲队获得了冠军，乙队获得了亚军。中间一大段内容被完全省略掉了。丙队获得了季军。';
    // 只在句末切分 → 整条摘录是一个锚点、不连续 → none；认逗号 → 两个锚点链上
    const ex = '甲队获得了冠军，丙队获得了季军。';
    expect(locateExcerpt(ex, doc, { implicitEllipsis: true }).kind).toBe('segmented');
  });

  it('★ 连续摘录优先走 T1，不会被隐式省略抢成 segmented', () => {
    const doc = '快速排序的复杂度是 O(n)。';
    const ex = '快速排序的复杂度是O(n)。'; // 空格差异 → T1
    expect(locateExcerpt(ex, doc, { implicitEllipsis: true }).kind).toBe('normalized');
  });

  it('★ 单锚点（无省略结构）不触发隐式切分 → 走 T1', () => {
    const doc = '前半句很长很长，后半句很长很长。';
    const ex = '前半句很长很长，后半句很长很长。';
    expect(locateExcerpt(ex, doc, { implicitEllipsis: true }).kind).toBe('exact');
  });

  it('★ occurrences 报出首锚点的歧义', () => {
    const doc = '重复的句子出现了一次。中间被省略的内容不少。重复的句子出现了一次。这里还有更多内容。这里结尾是另一句很长的话。';
    const ex = '重复的句子出现了一次。这里结尾是另一句很长的话。';
    const r = locateExcerpt(ex, doc, { implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
    expect(r.occurrences).toBe(2);
  });

  it('★ ignorePunctuation 模式：标点折成占位符，切分照常工作', () => {
    const doc = '第一句很长很长很长。被省略的中间段落。最后一句很长很长很长。';
    const ex = '第一句很长很长很长！最后一句很长很长很长？';
    const r = locateExcerpt(ex, doc, { ignorePunctuation: true, implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
    // 关掉隐式省略则同一摘录命中不了
    expect(locateExcerpt(ex, doc, { ignorePunctuation: true }).kind).toBe('none');
  });

  it('★ 跨块：原文句子之间有空行（分块），摘录合并 → 命中且 crossesBlocks', () => {
    const doc = [
      '第一句很长很长很长。',
      '',
      '被省略的中间段落第一部分。被省略的中间段落第二部分。',
      '',
      '最后一句很长很长很长。',
    ].join('\n');
    const ex = '第一句很长很长很长。最后一句很长很长很长。';
    const r = locateExcerpt(ex, doc, { markdown: md, implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
    expect(r.crossesBlocks).toBe(true);
    expect(doc.slice(r.index, r.index + r.length)).toContain('被省略的中间段落第一部分');
  });

  it('★ preset: loose 默认开启隐式省略', () => {
    const ex = '第一章的内容比较长比较长。第二章的内容同样也很长很长。';
    expect(locateExcerpt(ex, DOC, { preset: 'loose' }).kind).toBe('segmented');
  });

  it('★ preset: strict 不开启隐式省略 → none', () => {
    const ex = '第一章的内容比较长比较长。第二章的内容同样也很长很长。';
    expect(locateExcerpt(ex, DOC, { preset: 'strict' }).kind).toBe('none');
  });

  it('★ 契约：segmented 命中不携带 via（只有 fuzzy / semantic 才有）', () => {
    const ex = '第一章的内容比较长比较长。第二章的内容同样也很长很长。';
    const r = locateExcerpt(ex, DOC, { implicitEllipsis: true });
    expect(r.kind).toBe('segmented');
    expect(r.via).toBeUndefined();
  });
});

// jieba 是可选依赖，装了才跑按词判定的用例
let jieba: any = null;
try {
  jieba = require('@isdk/nlp-jieba');
} catch {
  jieba = null;
}

/**
 * 按词判定锚点强度（与 `locator.jieba.test.ts` 的 T2 用例同构）。
 *
 * 「他走了」是 3 个词但只有 3 个字符：字符阈值（minSegmentLength 4）会误杀，
 * 给了分词器后按词放行（>= 2 个完整的词）。单词锚点「前方」无论分词与否都被拒。
 */
describe.skipIf(!jieba)('隐式省略 + jieba：锚点强度按词判定', () => {
  // 中段刻意短一些，使命中字数 / span 不至于跌破覆盖率下限（测的是词数守卫，不是覆盖率）
  const doc = '他走了很远了。中间被省略的填充内容。前方就是终点。';
  const seg = {
    countWords: (t: string) => jieba.tokenize(t).filter((w: any) => /\p{L}|\p{N}/u.test(w.word)).length,
  };

  it('★ 3 字 3 词的短锚点：不给分词器 → 字符阈值拒绝', () => {
    jieba.addDefaultDict();
    expect(locateExcerpt('他走了。前方就是终点。', doc).kind).toBe('none');
  });

  it('★ 给了 jieba：3 字 = 3 个词 → segmented 命中', () => {
    jieba.addDefaultDict();
    const r = locateExcerpt('他走了。前方就是终点。', doc, { implicitEllipsis: true, cjkWordSegmenter: seg });
    expect(r.kind).toBe('segmented');
    expect(doc.slice(r.index, r.index + r.length)).toBe(doc);
  });

  it('★ 单词锚点即使分词也仍被拒：「前方」是 1 个词', () => {
    jieba.addDefaultDict();
    expect(locateExcerpt('前方。他走了很远了。', doc, { implicitEllipsis: true, cjkWordSegmenter: seg }).kind).toBe('none');
  });
});
