/**
 * `@isdk/whitespace-semantics` —— 脚本感知的空白处理。
 *
 * 判断两个字符之间的空白是**排版产物**（可删）还是**内容**（必须保留）。
 *
 * 判据：**删掉它会不会造成词/语素边界的歧义**。
 *
 * | 文字 | 用空格分词？ | 删空格后果 | 处理 |
 * |---|---|---|---|
 * | 汉字 / 假名 | 否 | 边界仍清晰 | 删 |
 * | **韩文** | 是 | 助词归属歧义 → 意思变 | 保留 |
 * | **泰文** | 否（空格表句子边界） | 丢失句子边界 | 保留 |
 * | 拉丁 / 数字 | 是 | `thecourt` ≠ `the court` | 保留 |
 *
 * @example
 * ```ts
 * canDropSpaceBetween('han', 'latin');  // true  中文 AI → 中文AI
 * canDropSpaceBetween('latin', 'latin'); // false the court
 * canDropSpaceBetween('hangul', 'hangul'); // false 아버지가 방에
 * ```
 *
 * @packageDocumentation
 */

export { unicodeScriptOf, canDropSpaceBetween, WHITESPACE_ROLE_BY_SCRIPT } from './whitespace';
export type { UnicodeScript, WhitespaceRole } from './whitespace';
