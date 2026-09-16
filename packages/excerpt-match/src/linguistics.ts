/**
 * 语言学工具：否定检测、的/地/得判定、语言策略。独立入口，不引入匹配器。
 *
 * ```ts
 * import { detectNegation } from 'excerpt-match/linguistics';
 * detectNegation('他没来').negated; // true
 * ```
 */
export {
  detectNegation,
  negationsConflict,
  CHINESE_NEGATION_WORDS,
  CHINESE_NON_NEGATION_WORDS,
  ENGLISH_NEGATION_WORDS,
} from '@isdk/zh-negation';
export type { Negation, NegationMark, NegationLexicon } from '@isdk/zh-negation';
export {
  detectLanguageProfile,
  languageProfileFor,
  tokenize,
  getWordSegmenter,
} from './languageProfiles';
export type { LanguageProfile } from './languageProfiles';
export {
  createGuardListParticleTagger,
  createJiebaParticleTagger,
  PARTICLE_TAGS,
  PARTICLES,
  SOLID_WORDS,
} from '@isdk/zh-particles';
export type { ParticleTagger, JiebaLike, JiebaTaggerOptions } from '@isdk/zh-particles';
