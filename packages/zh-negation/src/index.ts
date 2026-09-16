/**
 * `@isdk/zh-negation` —— 中文否定检测（词边界感知）。
 *
 * ## 它解决什么
 *
 * 判断一段文本是否含否定 —— 听起来是 `includes('不')` 的事，
 * 实际上难在**同一个字在不同位置是不是否定词**：
 *
 * ```
 * 他未来      → 非否定（「未」是时间名词的一部分）
 * 他未能到场  → 否定
 * 非常高兴    → 非否定（实词）
 * 他不去      → 否定
 * 不得不去    → 非否定（双重否定 = 肯定）
 * ```
 *
 * 子串扫描会把 `非常`、`无锡`、`未来`、`非洲` 全判成否定。
 *
 * ## 用途
 *
 * - 引用校验：拒绝「意思相反」的摘录（相似度 0.9 但极性相反）
 * - 情感分析：否定是最强的情感翻转信号
 * - 法务 / 合规：「不得」「禁止」的边界
 * - 内容审核
 *
 * ## 为什么相似度拦不住相反语义
 *
 * 实测（页面 29 字，摘录漏了两个词）：
 *
 * ```
 * 人工智能在改变世界    score 0.947  ← 等价
 * 人工智能没在改变世界  score 0.900  ← 相反
 * ```
 *
 * **只差 0.047。** 字符相似度衡量的是"像不像"，
 * 而"意思是否一致"是蕴含（NLI）任务 —— 调阈值无解。
 * 但"有没有否定词"是**确定的**，本包做这件确定的事。
 *
 * @example
 * ```ts
 * detectNegation('人工智能没在改变世界').negated;  // true
 * detectNegation('他不得不去').negated;            // false（双重否定）
 * detectNegation('非常高兴').negated;              // false（实词）
 * detectNegation("don't know").negated;            // true（英文缩写）
 * detectNegation('他未来').negated;                // false（默认保守）
 * detectNegation('他未来', { negations: ['未来'] }).negated; // true（领域覆盖）
 * ```
 *
 * @packageDocumentation
 */

export {
  detectNegation,
  negationsConflict,
  setSegmenters,
  CHINESE_NEGATION_WORDS,
  CHINESE_NON_NEGATION_WORDS,
  CONFLICTING_WORDS,
  ENGLISH_NEGATION_WORDS,
} from './detectNegation';
export type {
  Negation,
  NegationMark,
  NegationLexicon,
  WordSegmenter,
} from './detectNegation';
