import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener } from '@isdk/md-flatten';
import { locateExcerpt } from './index';

const md = createMdastFlattener(fromMarkdown, { extensions: [gfm], mdastExtensions: [gfmFromMarkdown] });
const IGNORE = { markdown: md, ignorePunctuation: true as const };

/**
 * joined 视图的 `normToRaw`：归一化下标 → joined raw 下标的**两跳**映射。
 *
 * 为什么需要专门测试：`normalizeWithMap(j)` 会把 `j.back`（joined → 摊平）
 * 复合进结果的 `back`，所以 joined 视图的 `norm.back` 指向的是**摊平文本**
 * 而不是 joined raw。拿它直接切 `raw` 会整体错位（偏移 = 前面剥掉的分隔符数）。
 *
 * 错位的典型后果：punctFolded 的边缘标点扩展越过块边界，把下一块开头的
 * 标点吞进页面侧 —— 「真差异假放行」（漏报）或「无差异误报送审」（误报）。
 *
 * 这些测试从公共 API（`punctFolded`）验证映射的正确性；夹取本身依赖
 * 同源的块坐标（`rebaseBlocksToJoined`），一并覆盖。
 */
describe('normToRaw：joined 视图的归一化 → raw 两跳映射', () => {
  describe('多级嵌套块', () => {
    /**
     * 引用块内的两个段落各是一个块；嵌套子引用里的段落又是独立的块。
     * joined raw 把它们全部首尾相接：`…second part` + `.Deeply nested…`。
     *
     * 摘录末尾的「.」在命中区域（引用块前两段）里没有对应 —— 它其实来自
     * 嵌套子块的开头。扩展必须被夹在前两个块的范围内 → true。
     */
    it('★ 引用块内跨段：摘录末尾句号来自嵌套子块开头 → true', () => {
      const doc = [
        '> Outer quote first part HERE',
        '>',
        '> Outer quote second part',
        '>',
        '> > .Deeply nested inner part',
        '',
        '.Tail block after quote',
      ].join('\n');
      const r = locateExcerpt('Outer quote first part hereOuter quote second part.', doc, IGNORE);
      expect(r.kind).toBe('normalized');
      expect(r.crossesBlocks).toBe(true);
      // span 不越过嵌套子块 —— 句号在命中区域内无对应，必须送复核
      expect(doc.slice(r.index, r.index + r.length)).not.toContain('Deeply');
      expect(r.punctFolded).toBe(true);
    });

    /**
     * 同结构，但页面段落自己以句号收尾、摘录也带着 —— 有就有，
     * 扩展在块内补上句号后两侧相等 → false。夹取不得误伤块内扩展。
     */
    it('引用块内跨段：两侧的句号都真实存在（页面段自收句号）→ false', () => {
      const doc = [
        '> Outer quote first part HERE',
        '>',
        '> Outer quote second part.',
        '>',
        '> > .Deeply nested inner part',
        '',
        '.Tail block after quote',
      ].join('\n');
      const r = locateExcerpt('Outer quote first part hereOuter quote second part.', doc, IGNORE);
      expect(r.kind).toBe('normalized');
      expect(r.crossesBlocks).toBe(true);
      expect(r.punctFolded).toBe(false);
    });

    /**
     * 列表：每个列表项的段落各是一个块，嵌套列表的条目也是。
     * 第三个条目以「.」开头 —— 摘录末尾的句号是拼不出来的、来自下一块。
     */
    it('★ 列表（含嵌套列表）：摘录末尾句号来自下一列表项开头 → true', () => {
      const doc = ['- Outer item one HERE', '  - Nested item alpha', '- .Outer item two starts with dot'].join('\n');
      const r = locateExcerpt('Outer item one hereNested item alpha.', doc, IGNORE);
      expect(r.kind).toBe('normalized');
      expect(r.crossesBlocks).toBe(true);
      expect(doc.slice(r.index, r.index + r.length)).not.toContain('two');
      expect(r.punctFolded).toBe(true);
    });
  });

  describe('实体转义', () => {
    /**
     * 实体让一个可见字符横跨多个源码字符（`&amp;` → `&`），而 joined 的
     * 坐标链是「按可见字符」逐个建立的。下一块以 `&amp;`（可见 `&`，标点）开头，
     * 摘录末尾的 `&` 在命中区域内没有对应 —— 夹取后必须判 true。
     */
    it('★ 下一块以 &amp; 开头：摘录末尾 & 在命中区域内无对应 → true', () => {
      const doc = [
        'First part &amp; more HERE',
        '',
        'Second part &amp; begins',
        '',
        '&amp; third block starts ampersand',
      ].join('\n');
      const r = locateExcerpt('First part & more hereSecond part & begins&', doc, IGNORE);
      expect(r.kind).toBe('normalized');
      expect(r.crossesBlocks).toBe(true);
      expect(doc.slice(r.index, r.index + r.length)).not.toContain('third');
      expect(r.punctFolded).toBe(true);
    });

    /**
     * 页面块自己以句号收尾、下一块以 `&amp;` 开头：joined raw 里两个标点
     * 背靠背（`…begins.& tail`）。不夹取会把两个都吞进去（`…begins.&`），
     * 与摘录（`…begins.`）不等 → 误报 true；夹取后只补块内的句号 → false。
     */
    it('块自收句号 + 下一块以 &amp; 开头：只补块内的句号 → false', () => {
      const doc = ['First part &amp; more HERE', '', 'Second part &amp; begins.', '', '&amp; tail block'].join('\n');
      const r = locateExcerpt('First part & more hereSecond part & begins.', doc, IGNORE);
      expect(r.kind).toBe('normalized');
      expect(r.crossesBlocks).toBe(true);
      // 源码 span 保留实体的原始形态（&amp;），坐标没有因实体展开而错位
      expect(doc.slice(r.index, r.index + r.length)).toContain('&amp;');
      expect(r.punctFolded).toBe(false);
    });

    /**
     * 数字实体（`&#39;` → `'`、`&#34;` → `"`）走同一条坐标链。
     * 两侧的引号与句号都真实存在 → false。
     */
    it('数字实体（&#39; / &#34;）解码后参与命中与边缘判定 → false', () => {
      const doc = ['It&#39;s fine HERE', '', 'Next &#34;block&#34; ends.', '', '. stray dot'].join('\n');
      const r = locateExcerpt("It's fine hereNext \"block\" ends.", doc, IGNORE);
      expect(r.kind).toBe('normalized');
      expect(r.crossesBlocks).toBe(true);
      expect(doc.slice(r.index, r.index + r.length)).toContain('&#39;');
      expect(r.punctFolded).toBe(false);
    });
  });
});
