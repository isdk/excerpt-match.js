/**
 * 文本底层工具：字形簇、文字类别、归一化。独立入口，不引入匹配器。
 *
 * ```ts
 * import { snapToGraphemeBoundary, unicodeScriptOf } from 'excerpt-match/text';
 * ```
 */
export { snapToGraphemeBoundary, countGraphemes } from '@isdk/normalize-text';
export type { TextSpan } from '@isdk/normalize-text';
export { unicodeScriptOf, canDropSpaceBetween } from '@isdk/whitespace-semantics';
export type { UnicodeScript } from '@isdk/whitespace-semantics';
export { normalizeWithMap } from '@isdk/normalize-text';
export type { NormalizeOptions } from '@isdk/normalize-text';
