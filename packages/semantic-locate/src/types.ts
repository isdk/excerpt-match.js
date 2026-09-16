/**
 * `@isdk/semantic-locate` 的对外契约。
 *
 * @remarks
 * 本包刻意**只处理纯字符串偏移** —— 不引入归一化、md 源码、代理对这些概念。
 * 坐标系的翻译由调用方完成，这样本包可以被任何「有文本 + 想定位」的场景复用。
 *
 * @packageDocumentation
 */

/**
 * 一次语义定位的结果。
 *
 * @remarks
 * ### `score` 的语义随 `via` 而变 —— 这是刻意的
 *
 * 三种分数**量纲不同，不可直接比较**：
 *
 * | 来源 | 语义 | 上界 |
 * |---|---|---|
 * | BM25 | 相关性**排序分** | **无界** |
 * | 余弦相似度 | 方向相似度 | -1~1 |
 * | 对齐（编辑距离类） | **绝对**相似度 | 0~1 |
 *
 * 把 BM25 的 `12.5` 与对齐的 `0.87` 做 `Math.min` 是错的 ——
 * 它假设两者同量纲。钳到 `[0,1]` 更糟：把无界的相对分
 * **伪装成**"看起来正常的绝对分"，调用方会误拿去做阈值决策。
 *
 * 所以本包让**召回只做它擅长的事：排序**：
 *
 * - `via: 'aligned'` —— `score` 是**对齐分**，绝对、跨查询可比，可用于阈值决策
 * - `via: 'segment'` —— 没有对齐分可用，`score` 是**归一化后的召回分**，
 *   **仅排序意义**，不可跨查询比较。判断可靠性请看 `recallRank`
 */
export interface SemanticHit {
  /** 命中区间起点（含），相对**输入文本** */
  start: number;
  /** 命中区间终点（不含） */
  end: number;
  /**
   * 见 {@link SemanticHit} 的说明：`via` 不同则语义不同。
   *
   * `via: 'segment'` 时**仅排序意义**，不要跨查询比较。
   */
  score: number;
  /**
   * 经过的路径：
   * - `aligned` —— 段内对齐成功，`score` 是绝对相似度
   * - `segment` —— 无 aligner 或对齐失败，退回整段，
   *   `score` 仅排序意义
   */
  via: 'aligned' | 'segment';
  /** 命中段落的序号，便于调试与日志 */
  segmentIndex: number;
  /**
   * 召回位次（0 起）。
   *
   * @remarks
   * 这是**唯一跨检索器实现都可比**的指标 ——
   * BM25 的 12.5 和余弦的 0.8 之间无从比较，但"排第几"永远可比。
   */
  recallRank: number;
  /**
   * 检索器返回的原始分（未归一化）。
   *
   * @remarks
   * 仅供调试与日志 —— **不要**用它做阈值决策，语义由检索器决定。
   */
  recallScore?: number;
}

/**
 * 语义检索器：给定摘录与候选段落，返回最像的几段及分数。
 *
 * @remarks
 * 可以是本地 embedding（`@xenova/transformers`）、云 API，或纯关键词的 BM25。
 * 本包**不提供**实现 —— 那是别人的专长。允许返回 Promise。
 */
export type SemanticRetriever = (
  excerpt: string,
  segments: string[],
  ctx: SemanticContext
) => Array<{ index: number; score: number }> | Promise<Array<{ index: number; score: number }>>;

/** 传给检索器的上下文 */
export interface SemanticContext {
  /** 语言标识（如 `zh` / `en`），便于检索器选择模型 */
  locale?: string;
  /** 分词函数，供 BM25 之类的检索器使用 */
  tokenize?: (text: string) => string[];
}

/**
 * 段内对齐器：把摘录精确定位到**某个段落内部**。
 *
 * @remarks
 * 通常用 `@isdk/approx-text-match` —— 段内做一次近似定位即可。
 * 不传则退化为高亮整段（并降分）。
 *
 * 第三个参数 `segmentStart` 是**该段在输入文本中的起始下标**，供调用方
 * 把「段内偏移」换算成整页坐标。**不能靠 `indexOf` 反查** ——
 * 重复段落会查到第一个，坐标就错了。
 *
 * 虽然类型上是必填，但**实现方可以只声明两个参数** —— TS 允许实现的
 * 形参数量少于调用方，所以旧的 `(excerpt, seg) => …` 依然可直接传入。
 */
export type SegmentAligner = (
  excerpt: string,
  segmentText: string,
  segmentStart: number
) => { start: number; end: number; score: number } | null;

/**
 * 极性判定函数。
 *
 * @remarks
 * 默认用 `@isdk/zh-negation`。之所以做成可注入，是因为
 * 否定判定高度依赖领域（法律文本与口语稿的判据不同）。
 */
export type PolarityFn = (text: string) => { negated: boolean };

export interface LocateSemanticOptions {
  /** 召回后取前几名做对齐 @defaultValue 3 */
  topK?: number;
  /**
   * 召回分数下限。
   *
   * @remarks
   * **这是相对分，语义完全由检索器决定** —— 本包不假设它有上界。
   *
   * - 余弦相似度类：默认 `0.5` 有意义
   * - **BM25：无意义**，请传 `undefined`（只用 `topK` 截断）或先自行归一化
   *
   * 换句话说：本包真正依赖的是**顺序**（`topK`），不是这个阈值。
   *
   * @defaultValue 0.5
   */
  minRecallScore?: number;
  /**
   * 段内对齐分数下限 @defaultValue 0.6
   *
   * @remarks
   * 与 {@link LocateSemanticOptions.minRecallScore} 不同，
   * **这个是绝对分** —— 对齐器（编辑距离类）的分数天生在 0~1，
   * 跨查询可比，适合做阈值决策。
   */
  minAlignScore?: number;
  /** 段内对齐器；不传则退回整段 */
  aligner?: SegmentAligner;
  /**
   * 是否做极性检查：摘录与召回段落一个肯定、一个否定时视为未命中。
   *
   * @remarks
   * 语义层尤其需要 —— 改写后字面差异更大，余弦相似度更不可靠：
   * 「改变世界」与「没在改变世界」在向量空间里反而很近。
   *
   * @defaultValue `true`
   */
  checkPolarity?: boolean;
  /** 自定义极性判定（默认 `@isdk/zh-negation`） */
  polarity?: PolarityFn;
  /** 传给极性判定的领域词表 */
  negationLexicon?: NegationLexicon;
  /** 切段时的单段最大长度 @defaultValue 300 */
  maxSegmentLength?: number;
  /**
   * 语言标识，原样传给检索器（见 {@link SemanticContext.locale}）。
   *
   * @remarks
   * 本包**不探测语言** —— 探测是调用方（或语言策略包）的职责。
   * 但检索器常常需要它来选模型，所以这里只做透传。
   */
  locale?: string;
  /** 分词函数，原样传给检索器（BM25 之类需要） */
  tokenize?: (text: string) => string[];
}

// 仅用于 JSDoc 链接
import type { NegationLexicon } from '@isdk/zh-negation';
