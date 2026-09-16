/**
 * excerpt-match —— 判断摘录是否出自页面正文，并定位到原文中的精确坐标。
 *
 * 典型用法见 {@link locateExcerpt} 与 {@link createTextIndex}。
 *
 * @packageDocumentation
 */

export type {
  ExcerptMatch,
  MatchKind,
  MatchOptions,
  NormalizedText,
  FallbackMatcher,
  Candidate,
  MatchContext,
  MarkdownFlattener,
  FlatBlock,
  FlatResult,
  InlineConstruct,
  EllipsisPattern,
} from './types';
export { NO_MATCH, isHit, DEFAULT_ELLIPSIS } from './types';

export { STRICT, DEFAULT_PRESET, LOOSE, withPreset } from './presets';
export type { PresetName } from './presets';
export { normalizeWithMap } from '@isdk/normalize-text';
export { unicodeScriptOf, canDropSpaceBetween } from '@isdk/whitespace-semantics';
export type { UnicodeScript } from '@isdk/whitespace-semantics';
export type { WhitespaceRole } from '@isdk/whitespace-semantics';
export type { NormalizeOptions } from '@isdk/normalize-text';
export { createTextIndex, createPageIndex, locateExcerpt, spanFromNormalized } from './locator';
export type { TextIndex, PageIndex } from './locator';
export { languageProfileFor, detectLanguageProfile, tokenize } from './languageProfiles';
export { detectNegation, negationsConflict } from '@isdk/zh-negation';
export {
  createGuardListParticleTagger,
  createJiebaParticleTagger,
  PARTICLE_TAGS,
  PARTICLES,
  SOLID_WORDS,
} from '@isdk/zh-particles';
export type { ParticleTagger, JiebaLike, JiebaTaggerOptions } from '@isdk/zh-particles';
export type { Negation, NegationMark } from '@isdk/zh-negation';
export type { LanguageProfile } from './languageProfiles';
export {
  createMdastFlattener,
  regexFlattener,
  trimMarkdownEdges,
  expandToInlineMarkers,
  deriveJoined,
} from '@isdk/md-flatten';
export type { MdastOptions, FromMarkdown } from '@isdk/md-flatten';
export {
  createBitapFallback,
  createDmpFallback,
  createDmpEsFallback,
} from './fuzzyMatch';
export type {
  DiffMatchPatchLike,
  DmpEsLike,
  DmpEsMatchOptions,
  BitapMatcher,
  Differ,
  DiffOp,
  DiffChunk,
  BitapFallbackOptions,
} from '@isdk/approx-text-match';

export { splitSegments, locateSemantic } from './semanticMatch';
export type { SemanticRetriever, Segment } from './semanticMatch';
export { snapToGraphemeBoundary, countGraphemes } from '@isdk/normalize-text';
export type { TextSpan } from '@isdk/normalize-text';
export { createCjkNumberParser, CHINESE_NUMERAL_CHARS } from '@isdk/normalize-text';
export type { ChineseNumeralParser, ParsedChineseNumeral, CjkNumberLike, CjkNumeralParserOptions } from '@isdk/normalize-text';
