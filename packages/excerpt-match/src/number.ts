/**
 * 数字记法：独立入口，不引入匹配器。
 *
 * 千分位部分零依赖；中文数词走 `cjk-number`（可选，需注入后端）。
 *
 * ```ts
 * import { createCjkNumberParser } from 'excerpt-match/number';
 * import * as cjk from 'cjk-number';
 * createCjkNumberParser(cjk).parse('两万', 0); // { value: '20000', consumed: 2 }
 * ```
 *
 * @remarks
 * 这些实现属于 `@isdk/normalize-text` —— 数字记法在归一化流水线里
 * **位置敏感**（必须在 NFKC 之后、标点折叠之前），所以随归一化包发布。
 */
export {
  stripGroupingSeparators,
  buildGroupedDigitsPattern,
  GROUPED_DIGITS_PATTERN,
  createCjkNumberParser,
  CHINESE_NUMERAL_CHARS,
} from '@isdk/normalize-text';
export type {
  ChineseNumeralParser,
  ParsedChineseNumeral,
  CjkNumberLike,
  CjkNumeralParserOptions,
} from '@isdk/normalize-text';
