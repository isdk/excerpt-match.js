/**
 * `@isdk/zh-particles` —— 中文结构助词「的 / 地 / 得」的判定。
 *
 * ## 为什么不能无脑折叠
 *
 * 这三个字混用确实是常见错别字，但它们**同时也是实词的一部分**：
 *
 * | 原文 | 误用后 | 是否等价 |
 * |---|---|---|
 * | 他高兴**地**接受 | 他高兴**的**接受 | ✅ 是（助词） |
 * | 辽阔的**大地** | 辽阔的**大的** | ❌ 否（实词） |
 * | 他**得到**了批准 | 他**到的**了批准 | ❌ 否（实词） |
 *
 * 判定的关键不是"是不是这三个字"，而是**"此处的字是不是独立的助词 token"**。
 *
 * ## 三档
 *
 * | 档位 | 说明 |
 * |---|---|
 * | `false` | 不折叠（**默认**）—— 零误判 |
 * | `true` | 内置保守模式：实词保护表，零依赖但补不全 |
 * | `ParticleTagger` | 注入分词器（如 jieba），按词性精确判定 |
 *
 * @packageDocumentation
 */

export {
  createGuardListParticleTagger,
  createJiebaParticleTagger,
  PARTICLE_TAGS,
  PARTICLES,
  SOLID_WORDS,
} from './chineseParticles';
export type { ParticleTagger, JiebaLike, JiebaTaggerOptions } from './chineseParticles';
