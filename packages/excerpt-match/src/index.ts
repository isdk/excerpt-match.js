/**
 * excerpt-match —— 判断摘录是否出自文档正文，并定位到原文中的精确坐标。
 *
 * 典型用法见 {@link locateExcerpt}（同步定位）与 {@link matchExcerpt}（高层编排）。
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
 * 第三方依赖（jieba / cjk-number / diff-match-patch-es / mdast+GFM）已随本包
 * **必装**，由 `default*` 系列惰性装配成高层入口的内置默认 ——
 * `matchExcerpt(ex, text)` 零配置即可用，详见 `./defaults`。
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

export { createTextIndex, locateExcerpt, spanFromNormalized } from './locator';
export type { TextIndex } from './locator';

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
export {
  createExcerptMatcher,
  matchExcerpt,
} from './excerptMatcher';
export type {
  ExcerptMatchResult, ExcerptMatcher, ExcerptMatcherOptions,
} from './excerptMatcher';

/**
 * 内置默认依赖装配（Node 惰性加载，见 `./defaults` 的文件头说明）。
 *
 * @remarks
 * 高层入口已自动使用它们；导出出来是给需要「在默认之上做微调」的调用方
 * （例如给默认摊平器套一层缓存，或在默认模糊层之外再追加一个匹配器）。
 */
export {
  defaultCjkNumberParser,
  defaultFuzzyFallback,
  defaultMarkdownFlattener,
  defaultParticleTagger,
} from './defaults';

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
