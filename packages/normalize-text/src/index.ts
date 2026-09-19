/**
 * `@isdk/normalize-text` —— 归一化，同时保留原文坐标。
 *
 * ## 它解决什么
 *
 * 字符串归一化是常见需求，但现成库（`toLowerCase`、NFKC、各种 cleaner）
 * 有一个共同点：**它们只给你归一化后的字符串，不给坐标映射**。
 *
 * 于是"高亮搜索结果""定位引用出处""给 diff 标位置"这些需求全都做不了 ——
 * 你找不到归一化串里的第 i 个字符对应原文的哪里。
 *
 * 这个包提供 `normalizeWithMap(src, options)`：返回 {@link NormalizedText}，
 * 其中 `map` / `mapEnd` / `back` 三张表共同保证坐标可来回换算。
 *
 * @example
 * ```ts
 * const r = normalizeWithMap('第 1，000 条');
 * r.text;      // '第 1000 条'
 * r.map[2];    // 第 2 个字符在原文中的下标
 * ```
 *
 * ## 流水线：四个阶段，顺序是契约
 *
 * ```
 * 1. foldWidth          NFKC + 零宽字符剔除
 * 2. normalizeNumbers   数字记法
 * 3. foldCase           大小写
 * 4. foldPunctAndSpace  标点 / 助词 / 空白
 * ```
 *
 * **数字必须在 2**：
 * - 在 NFKC 之后 —— 中文文档里千分位多是全角 `1，000`，NFKC 前是 `，` 不是 `,`
 * - 在标点折叠之前 —— 顿号 `、` 不被 NFKC 折叠，早于此可区分
 *   `1,000`（千分位）与 `1、000`（列表）
 *
 * @packageDocumentation
 */

export type { NormalizedText } from './types';
export { normalizeWithMap } from './normalize';
export type { NormalizeOptions } from './normalize';

// ignorePunctuation 的三种写法（boolean / 'drop' / 对象）与归一化函数
export { normalizeIgnorePunctuationOption, withKeep } from './ignorePunctuation';
export type {
  IgnorePunctuationKeep, IgnorePunctuationMode, IgnorePunctuationOption,
  IgnorePunctuationOptions, ResolvedIgnorePunctuation,
} from './ignorePunctuation';

// 字形簇：命中边界要对齐，否则会切出半个 emoji
export { snapToGraphemeBoundary, countGraphemes } from './grapheme';
export type { TextSpan } from './grapheme';

// 数字记法：位置敏感（必须在 NFKC 之后、标点之前），故随本包发布
export {
  stripGroupingSeparators,
  buildGroupedDigitsPattern,
  GROUPED_DIGITS_PATTERN,
  createCjkNumberParser,
  CHINESE_NUMERAL_CHARS,
} from './numberNotation';
export type {
  ChineseNumeralParser,
  ParsedChineseNumeral,
  CjkNumberLike,
  CjkNumeralParserOptions,
} from './numberNotation';
