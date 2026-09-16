/**
 * `@isdk/md-flatten` —— markdown 源码 ↔ 渲染后文本的**双向坐标映射**。
 *
 * ## 它解决什么
 *
 * md 源码里有大量渲染后不可见的语法：`**`、`#`、`[](url)`、表格的 `|`。
 * 于是两个坐标系对不上：
 *
 * ```
 * 源码  : 本院**认为**被告构成[根本违约](http://x.com)。
 * 渲染后: 本院认为被告构成根本违约。
 *                    ↑
 *              用户复制的是这个，但你要高亮的是源码里的那一段
 * ```
 *
 * 这个包把 md 摊平成渲染后可见文本，同时给出**每个字符对应的源码下标**，
 * 并且能反向把一段可见文本换算回源码 span。
 *
 * ## 用途
 *
 * - 评论锚定（"选中这段文字"→ 存它在源码里的位置）
 * - 引用校验（用户复制的摘录 → 定位到源码哪一段）
 * - 文档 diff / 冲突标记
 *
 * ## 为什么用 mdast 而不是正则
 *
 * **mdast 每个节点自带 `position.offset`** —— 那就是现成的坐标映射。
 * "什么算渲染后可见"由解析器决定，不用猜；表格、删除线、脚注、转义这些
 * 正则写不对的东西全免费。
 *
 * @example
 * ```ts
 * import { fromMarkdown } from 'mdast-util-from-markdown';
 * import { gfm } from 'micromark-extension-gfm';
 * import { gfmFromMarkdown } from 'mdast-util-gfm';
 *
 * const flat = createMdastFlattener(
 *   (src) => fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
 * ).flatten(mdSource);
 *
 * flat.text;    // 渲染后可见文本
 * flat.map[10]; // 第 10 个字符在 md 源码中的下标
 * ```
 *
 * @packageDocumentation
 */

export {
  createMdastFlattener,
  regexFlattener,
  trimMarkdownEdges,
  expandToInlineMarkers,
  deriveJoined,
} from './markdown';
export type {
  MarkdownFlattener,
  MdastOptions,
  FromMarkdown,
  FlatResult,
  FlatBlock,
  InlineConstruct,
} from './markdown';

export { createCachedFlattener } from './cachedFlattener';
export type { CachedFlattener, CachedFlattenerOptions } from './cachedFlattener';
