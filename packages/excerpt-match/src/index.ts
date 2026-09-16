/**
 * excerpt-match —— 判断摘录是否出自页面正文，并定位到原文中的精确坐标。
 *
 * 典型用法见 {@link locateExcerpt} 与 {@link createTextIndex}。
 *
 * ## 关于子包
 *
 * 归一化、md 摊平、否定检测这些能力已经拆成**独立子包**，各自发布、各自有 README：
 *
 * | 能力 | 包 |
 * |---|---|
 * | 归一化 + 坐标映射 | `@isdk/normalize-text` |
 * | md 源码 ↔ 渲染后文本坐标 | `@isdk/md-flatten` |
 * | 近似区间定位（T3） | `@isdk/approx-text-match` |
 * | 两阶段语义定位（T4） | `@isdk/semantic-locate` |
 * | 脚本感知空白 | `@isdk/whitespace-semantics` |
 * | 标识符变体归一 | `@isdk/identifier-variants` |
 * | 中文否定检测 | `@isdk/zh-negation` |
 * | 的/地/得 判定 | `@isdk/zh-particles` |
 *
 * **本包不再代售它们的实现。** 想单独用某个能力，请直接装对应的子包 ——
 * 那样也不会把整个定位器拖进来。
 *
 * 本入口只保留两类东西：
 * 1. **本包自己实现的** API（定位、预设、语言策略、T3/T4 适配工厂）
 * 2. 这些 API **签名上出现的类型**（否则调用方没法传参 / 读返回值）
 *
 * @packageDocumentation
 */

// #region 本包自己的契约

export type {
  ExcerptMatch,
  MatchKind,
  MatchOptions,
  FallbackMatcher,
  Candidate,
  MatchContext,
  EllipsisPattern,
} from './types';
export { NO_MATCH, isHit, DEFAULT_ELLIPSIS } from './types';

export { STRICT, DEFAULT_PRESET, LOOSE, withPreset } from './presets';
export type { PresetName } from './presets';

export { createTextIndex, createPageIndex, locateExcerpt, spanFromNormalized } from './locator';
export type { TextIndex, PageIndex } from './locator';

export { languageProfileFor, detectLanguageProfile, tokenize } from './languageProfiles';
export type { LanguageProfile } from './languageProfiles';

/**
 * T3 / T4 的适配工厂：把子包能力接进本包的坐标系。
 *
 * @remarks
 * 这里只做**坐标翻译**，不重新实现任何匹配算法 ——
 * 算法属于 `@isdk/approx-text-match` 与 `@isdk/semantic-locate`。
 */
export {
  createBitapFallback,
  createDmpFallback,
  createDmpEsFallback,
} from './fuzzyMatch';
export { locateSemantic } from './semanticMatch';

// #endregion

// #region 类型接缝：本包 API 签名上出现、但归属子包的类型
//
// 保留 re-export 只是为了「能给本包 API 传参 / 能读它的返回值」，
// 实现与使用方式请看对应子包。这是契约边界，不是代售。

export type {
  NormalizedText,
  NormalizeOptions,
  ChineseNumeralParser,
} from '@isdk/normalize-text';
export type { ParticleTagger } from '@isdk/zh-particles';
export type { NegationLexicon } from '@isdk/zh-negation';

export type {
  MarkdownFlattener,
  FlatResult,
  FlatBlock,
  InlineConstruct,
} from '@isdk/md-flatten';

export type {
  BitapMatcher,
  Differ,
  DiffOp,
  DiffChunk,
  BitapFallbackOptions,
  DiffMatchPatchLike,
  DmpEsLike,
  DmpEsMatchOptions,
} from '@isdk/approx-text-match';

export type { SemanticRetriever } from '@isdk/semantic-locate';

// #endregion
