import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener, trimMarkdownEdges, expandToInlineMarkers } from './markdown';

/** GFM 必须同时给语法层与 AST 层，否则表格不解析 */
const flatten = createMdastFlattener(
  (src) => fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as never
);

/**
 * 摊平结果末尾会带块终止符（每个块一个 `\n`），
 * 比对时统一 `.trim()` —— 这是流水线约定，不是 bug。
 */
const text = (src: string) => flatten.flatten(src).text.trim();

describe('摊平：语法标记不进可见文本', () => {
  it('行内标记被移除', () => {
    expect(text('本院**认为**被告构成违约。')).toBe('本院认为被告构成违约。');
  });

  it('链接只留锚文本，URL 丢弃', () => {
    expect(text('参见[根本违约](http://a.b/c)条款')).toBe('参见根本违约条款');
  });

  it('标题 # 与表格 | 被移除', () => {
    const t = text('# 标题\n\n| a | b |\n| --- | --- |\n| 1 | 2 |');
    expect(t).toContain('标题');
    expect(t).toContain('12');
    expect(t).not.toContain('|');
  });

  it('图片 alt 不保留（渲染成 <img>，用户复制不到）', () => {
    expect(text('前![图](x.png)后')).toBe('前后');
  });
});

describe('★ 坐标映射：可见文本 ↔ md 源码', () => {
  it('每个字符都能回切到源码', () => {
    const src = '本院**认为**被告构成违约。';
    const r = flatten.flatten(src);
    for (let i = 0; i < r.text.length; i++) {
      if (r.text[i] === '\n') continue; // 块终止符是插入的，无对应源码
      const piece = src.slice(r.map[i], r.mapEnd?.[i] ?? r.map[i] + 1);
      expect(piece.length, `第 ${i} 个字符`).toBeGreaterThan(0);
    }
  });

  it('★ 补齐行内标记后，span 是独立可渲染的完整片段', () => {
    // 摘录「认为」在源码里是 **认为** —— 只回切字符坐标会得到半截
    const src = '本院**认为**被告构成违约。';
    const r = flatten.flatten(src);
    const at = r.text.indexOf('认为');
    const raw = { index: r.map[at], length: (r.mapEnd?.[at + 1] ?? r.map[at + 1]) - r.map[at] };
    expect(src.slice(raw.index, raw.index + raw.length)).toBe('认为'); // 未补齐：半截

    // 签名是 (flat, fromFlat, toFlat, srcStart, srcEnd)。
    // fromFlat/toFlat 是**可见文本**下标，且 toFlat 取**最后一个字符**而非结束边界。
    const full = expandToInlineMarkers(r, at, at + 1, raw.index, raw.index + raw.length);
    expect(src.slice(full.start, full.end)).toBe('**认为**'); // 补齐：完整
  });

  it('块级切片带源码坐标', () => {
    const src = '第一段。\n\n第二段。';
    const r = flatten.flatten(src);
    expect(r.blocks.length).toBe(2);
    expect(src.slice(r.blocks[0].srcStart, r.blocks[0].srcEnd)).toBe('第一段。');
    expect(src.slice(r.blocks[1].srcStart, r.blocks[1].srcEnd)).toBe('第二段。');
  });
});

describe('isSep：块间分隔符标记（供跨块匹配）', () => {
  it('块间分隔符被标记', () => {
    const r = flatten.flatten('甲\n\n乙');
    const sepCount = r.isSep?.filter(Boolean).length ?? 0;
    expect(sepCount).toBeGreaterThan(0);
  });

  it('块内字符不标记', () => {
    const r = flatten.flatten('甲\n\n乙');
    expect(r.isSep?.[0]).toBe(false); // 「甲」
  });
});

describe('trimMarkdownEdges', () => {
  it('两端都剪掉标记，只留内容', () => {
    // `**被告**` → 内容「被告」，起点后移 2，长度 2
    const r = trimMarkdownEdges('**被告**', 0, 6);
    expect(r.index).toBe(2);
    expect(r.length).toBe(2);
    expect('**被告**'.slice(r.index, r.index + r.length)).toBe('被告');
  });

  it('只剪两端，中间与尾部内容保留', () => {
    const r = trimMarkdownEdges('**被告**的行为', 0, 10);
    expect(r.index).toBe(2);
    expect(r.length).toBe(8);
  });

  it('★ 默认关闭：它会剪掉刚补齐的标记，与「精确」冲突', () => {
    // 主包把 trimMarkdownEdges 默认设为 false 就是这个原因。
    // 这个函数保留在此供调用方显式使用。
    const r = trimMarkdownEdges('本院**认为**', 2, 4);
    expect('本院**认为**'.slice(r.index, r.index + r.length)).toBe('认为');
  });
});

describe('正则降级版（未注入 mdast 时）', () => {
  it('基本行内标记可用', async () => {
    const { regexFlattener } = await import('./markdown');
    expect(regexFlattener.flatten('本院**认为**被告。').text.trim()).toBe('本院认为被告。');
  });
});
