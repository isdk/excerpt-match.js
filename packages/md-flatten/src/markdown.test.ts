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

  it('★ 行内代码：反引号同样是行内标记，span 要补齐两侧', () => {
    // 回归：inlineCode 分支曾提前 return，绕过了 INLINE_TYPES 的登记，
    // 于是 constructs 里没有它、inl 全是 -1，补齐无从谈起 ——
    // 引用会切出「React 18` 通过在…」这种半截反引号。
    const src = '`React 18` 引入了新的 root API。';
    const r = flatten.flatten(src);
    const at = r.text.indexOf('React 18');
    expect(r.inl?.[at] ?? -1).toBeGreaterThanOrEqual(0); // 该字符属于某个行内构造

    const raw = { index: r.map[at], length: (r.mapEnd?.[at + 7] ?? r.map[at + 7]) - r.map[at] };
    expect(src.slice(raw.index, raw.index + raw.length)).toBe('React 18'); // 未补齐：半截

    const full = expandToInlineMarkers(r, at, at + 7, raw.index, raw.index + raw.length);
    expect(src.slice(full.start, full.end)).toBe('`React 18`'); // 补齐：完整
  });

  it('块级切片带源码坐标', () => {
    const src = '第一段。\n\n第二段。';
    const r = flatten.flatten(src);
    expect(r.blocks.length).toBe(2);
    expect(src.slice(r.blocks[0].srcStart, r.blocks[0].srcEnd)).toBe('第一段。');
    expect(src.slice(r.blocks[1].srcStart, r.blocks[1].srcEnd)).toBe('第二段。');
  });
});

describe('★ 代理对：map 与 text 必须按 code unit 对齐', () => {
  it('map 与 text 同长（外加哨兵），emoji 后的段落不错位', () => {
    const src = '甲👍乙。\n\n第二段内容。';
    const r = flatten.flatten(src);
    expect(r.map.length).toBe(r.text.length + 1);

    const at = r.text.indexOf('第');
    expect(src.slice(r.map[at], r.mapEnd?.[at] ?? r.map[at] + 1)).toBe('第');
  });

  it('emoji 占两个 code unit，两条 map 共享同一源码区间', () => {
    const src = '甲👍乙。';
    const r = flatten.flatten(src);
    const at = r.text.indexOf('\u{1F44D}');
    expect(r.map[at]).toBe(r.map[at + 1]);
    expect(r.mapEnd?.[at]).toBe(r.mapEnd?.[at + 1]);
    expect(src.slice(r.map[at], r.mapEnd?.[at] ?? r.map[at] + 1)).toBe('\u{1F44D}');
  });

  it('逐个字符往返：含 emoji 时每个字符仍能回切到源码', () => {
    const src = '合议庭组成：👨‍👩‍👧‍👦 出席了庭审。\n\n书证上有 🇨🇳 与 👍🏽 两个标记。';
    const r = flatten.flatten(src);
    for (let i = 0; i < r.text.length; i++) {
      if (r.text[i] === '\n') continue; // 块终止符是插入的，无对应源码
      expect(r.map[i], `第 ${i} 个字符`).toBeLessThan(src.length);
    }
  });
});

describe('★ 转义与实体：一个可见字符横跨多个源码字符', () => {
  /** 该可见字符在源码里到底占了哪一段 */
  const srcOf = (src: string, ch: string) => {
    const r = flatten.flatten(src);
    const i = r.text.indexOf(ch);
    return { i, piece: src.slice(r.map[i], r.mapEnd?.[i] ?? r.map[i] + 1), map: r.map };
  };

  it('转义 \\* 的坐标覆盖整个 `\\*`，不指向文末', () => {
    const { piece, map } = srcOf('a \\* b', '*');
    expect(piece).toBe('\\*');
    // 塌陷 bug 的表征：从这里起 map 全部等于同一个值
    expect(map.slice(0, 5)).toEqual([0, 1, 2, 4, 5]);
  });

  it('实体 &gt; 同理：&amp; 因首字符恰好是 & 而侥幸正确，掩盖了这个 bug', () => {
    const { piece, map } = srcOf('a &gt; b', '>');
    expect(piece).toBe('&gt;');
    expect(map.slice(0, 5)).toEqual([0, 1, 2, 6, 7]);
  });

  it('数值实体 &#39; / &#x27; 也能正确回切', () => {
    expect(srcOf('a &#39; b', "'").piece).toBe('&#39;');
    expect(srcOf('a &#x27; b', "'").piece).toBe('&#x27;');
  });

  it('逐个往返：切出来的源码片段能还原出该可见字符', () => {
    const src = '附注：定界符 \\* 与表达式 a &gt; b，详见附件。';
    const r = flatten.flatten(src);
    for (let i = 0; i < r.text.length; i++) {
      if (r.text[i] === '\n') continue; // 块终止符是插入的，无对应源码
      expect(src.slice(r.map[i], r.mapEnd?.[i] ?? r.map[i] + 1).length, `第 ${i} 个字符`).toBeGreaterThan(0);
      // 任何字符都不该把坐标推到文末 —— 那正是级联塌陷的症状
      expect(r.map[i]).toBeLessThan(src.length);
    }
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

  it('与 mdast 路径一致：转义与实体都解码', async () => {
    const { regexFlattener } = await import('./markdown');
    expect(regexFlattener.flatten('a \\* b').text).toBe('a * b');
    expect(regexFlattener.flatten('a &gt; b').text).toBe('a > b');
    expect(regexFlattener.flatten('a &amp; b').text).toBe('a & b');
  });

  it('★ 转义字符的 span 覆盖整个 `\\*`，不是只到反斜杠', async () => {
    const { regexFlattener } = await import('./markdown');
    const src = 'a \\* b';
    const r = regexFlattener.flatten(src);
    const i = r.text.indexOf('*');
    expect(src.slice(r.map[i], r.mapEnd?.[i] ?? r.map[i] + 1)).toBe('\\*');
  });

  it('★ 实体解码后，坐标仍回切到整个引用', async () => {
    const { regexFlattener } = await import('./markdown');
    const src = 'a &gt; b';
    const r = regexFlattener.flatten(src);
    const i = r.text.indexOf('>');
    expect(src.slice(r.map[i], r.mapEnd?.[i] ?? r.map[i] + 1)).toBe('&gt;');
  });
});
