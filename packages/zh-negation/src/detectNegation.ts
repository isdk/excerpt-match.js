/**
 * 中文否定检测 —— **词边界感知**。
 *
 * @remarks
 * 难点不是"有没有否定词"，而是**同一个字在不同位置是不是否定词**：
 *
 * | 文本 | 「未」的角色 | 是否否定 |
 * |---|---|---|
 * | 他**未**来 | 时间名词的一部分 | 否 |
 * | 他**未**能到场 | 否定词 | 是 |
 * | **非常**高兴 | 实词（非+常） | 否 |
 * | 他**不**去 | 否定词 | 是 |
 *
 * ## 三个必须做对的点
 *
 * 1. **在词边界上认否定词**，而不是子串扫描 —— 否则 `非常`、`无锡`、`未来` 全被误判
 * 2. **只比奇偶不比用词** —— `不去` 与 `没去` 同为否定，不算冲突
 * 3. **排除表按整个词匹配**，不按前缀 —— 前缀会误杀 `无法`、`无论` 这些真否定词
 *
 * ## 无法消歧时保守，理由是代价不对称
 *
 * 多义词（`未来`）取哪个义取决于上下文，那是词义消歧（WSD），超出本包范围。
 * 默认取**高频义**（时间名词 → 非否定），因为：
 *
 * - 漏判只是少一道守卫
 * - 误拒是让合法文本彻底判错
 *
 * 需要覆盖时传 {@link NegationLexicon}。
 *
 * @packageDocumentation
 */

/** 分词器：给定文本，产出 `{ segment, index }`。默认用 `Intl.Segmenter` */
export interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; index: number }>;
}

/** 用 `Intl.Segmenter` 的默认分词器（内置，零依赖） */
function createDefaultSegmenter(locale: string): WordSegmenter {
  let seg: Intl.Segmenter | null = null;
  return {
    segment(text: string) {
      if (!seg) seg = new Intl.Segmenter(locale, { granularity: 'word' });
      return seg.segment(text) as Iterable<{ segment: string; index: number }>;
    },
  };
}

let zhSeg: WordSegmenter | null = null;
let enSeg: WordSegmenter | null = null;
function zh(): WordSegmenter {
  return (zhSeg ??= createDefaultSegmenter('zh'));
}
function en(): WordSegmenter {
  return (enSeg ??= createDefaultSegmenter('en'));
}

/**
 * 注入自定义分词器（如 jieba），提升领域术语的切分准确度。
 *
 * @remarks
 * 不注入也能用 —— 内置走 `Intl.Segmenter`，零依赖。
 */
export function setSegmenters(z: WordSegmenter | null, e: WordSegmenter | null): void {
  zhSeg = z;
  enSeg = e;
}

/** 一个否定标记 */
export interface NegationMark {
  /** 在输入文本中的起始下标 */
  at: number;
  /** 匹配到的否定词 */
  word: string;
}

/** 文本的否定状态 */
export interface Negation {
  marks: NegationMark[];
  /**
   * 是否否定。**按否定标记个数的奇偶**判断 ——
   * 双重否定（`不得不`）算肯定，这与中文实际一致。
   */
  negated: boolean;
}

/** 中文否定词（作**独立词**时才算） */
export const CHINESE_NEGATION_WORDS: ReadonlySet<string> = new Set([
  '没有', '不是', '不能', '不会', '不要', '不必', '不该', '未能', '尚未',
  '并非', '从未', '未曾', '并不', '绝不', '并非', '无法', '无需', '未必',
  '不', '没', '无', '未', '非', '别', '莫', '勿', '否', '休',
]);

/**
 * 中文**实词**白名单：含否定字但**不是**否定的常见词。
 *
 * @remarks
 * 这是「排除表」而非「保护表」—— 按**整个词**匹配，不按前缀。
 * 前缀匹配会误杀 `无法` / `无论` / `无意` 这些真正的否定词。
 */
export const CHINESE_NON_NEGATION_WORDS: ReadonlySet<string> = new Set([
  '非常', '别人', '别的', '非法', '除非', '非洲', '是非', '非议',
  '无锡', '无意', '无关', '无论', '无穷', '无限', '无奈', '无耻',
  '未来', '未免',
  '特别', '区别', '分别', '类别', '级别', '差别', '告别', '送别',
  '休息', '退休', '否定', '否则', '是否',
]);

/**
 * 自检：同时出现在两个词表里的词。
 *
 * @remarks
 * **非否定表优先级最高**，所以一个词若同时存在，它在否定表里的声明会
 * **静默失效** —— 这类冲突极难发现（`尚未`、`未必`、`未曾` 都曾中招）。
 *
 * 这个常量让冲突可被断言，而非靠人眼比对两张表。
 */
export const CONFLICTING_WORDS: ReadonlySet<string> = new Set(
  [...CHINESE_NEGATION_WORDS].filter((w) => CHINESE_NON_NEGATION_WORDS.has(w))
);

/** 汉字判定：只在汉字 token 的起点做匹配，避免英文单词内误命中 */
const HAN_PATTERN = /[\u4e00-\u9fff\u3400-\u4dbf]/;

/** 否定词最长按多少字匹配。词表里最长的词是 4 字（如 `尚未`、`未必`） */
const MAX_NEGATION_WORD_LENGTH = 4;

/** 英文否定词（整个词匹配） */
export const ENGLISH_NEGATION_WORDS: ReadonlySet<string> = new Set([
  'not', 'never', 'neither', 'nor', 'without', 'cannot', 'hardly',
  'nowhere', 'nothing', 'no', 'none', 'nobody', 'cannot', "won't",
]);

/** 英文缩写否定后缀：`don't` / `doesn't` / `didn't` / `isn't` / `aren't` … */
const ENGLISH_NEGATION_SUFFIX = "n't";



/**
 * 检测文本中的否定标记。
 *
 * 英文靠**词形**（整个词匹配，或以 `n't` 结尾），中文靠**分词边界**，
 * 两者同时检测 —— 中文文档夹英文很常见，反之亦然。
 *
 * @param text 待检测文本（建议传归一化后的）
 * @returns 否定状态
 *
 * @example
 * ```ts
 * detectNegation('人工智能没在改变世界').negated;  // true
 * detectNegation('人工智能在改变世界').negated;    // false
 * detectNegation('他不得不去').negated;            // false（双重否定）
 * detectNegation('非常高兴').negated;              // false（实词，非否定）
 * detectNegation("don't know").negated;            // true（英文缩写）
 * ```
 */
/**
 * 领域词表：覆盖内置的默认判断。
 *
 * @remarks
 * **多义词（如「未来」）没有通用解法** —— 它究竟是时间名词还是「没有来」的省略，
 * 取决于上下文，这是词义消歧（WSD）问题，超出本库范围。
 *
 * 本库的处理是：**保守默认 + 允许调用方按领域覆盖**。
 * 法律、医疗、金融等领域的否定用法差异很大，通用词表必然有偏差，
 * 所以把这个口子留出来，而不是假装能自动判断。
 *
 * @example 让「未来」也视为否定（口语稿场景）
 * ```ts
 * locateExcerpt(ex, page, {
 *   negationLexicon: { negations: ['未来'] },
 * })
 * ```
 *
 * @example 让某词永远不算否定（产品名、术语）
 * ```ts
 * locateExcerpt(ex, page, {
 *   negationLexicon: { nonNegations: ['无限制', '非凡'] },
 * })
 * ```
 */
export interface NegationLexicon {
  /** 追加的否定词 */
  negations?: Iterable<string>;
  /** 追加的**非**否定词（优先级高于 {@link negations}，也高于内置否定词） */
  nonNegations?: Iterable<string>;
}

/** 合并内置词表与领域词表。`nonNegations` 优先级最高 */
function mergeLexicon(lexicon?: NegationLexicon): {
  negations: Set<string>;
  nonNegations: Set<string>;
} {
  const negations = new Set(CHINESE_NEGATION_WORDS);
  const nonNegations = new Set(CHINESE_NON_NEGATION_WORDS);
  if (lexicon?.negations) {
    for (const w of lexicon.negations) {
      negations.add(w);
      // 关键：显式声明为否定词时，要**解除**内置白名单对它的保护，
      // 否则「未来」这类内置非否定词永远覆盖不掉
      nonNegations.delete(w);
    }
  }
  // nonNegations 后处理，优先级最高
  if (lexicon?.nonNegations) {
    for (const w of lexicon.nonNegations) {
      nonNegations.add(w);
      negations.delete(w);
    }
  }
  return { negations, nonNegations };
}

/**
 * 检测文本中的否定标记。
 *
 * 英文靠**词形**（整个词匹配，或以 `n't` 结尾），中文靠**分词边界**，
 * 两者同时检测 —— 中文文档夹英文很常见，反之亦然。
 *
 * @param text 待检测文本（建议传归一化后的）
 * @param lexicon 可选的领域词表，见 {@link NegationLexicon}
 * @returns 否定状态
 *
 * @example
 * ```ts
 * detectNegation('人工智能没在改变世界').negated;  // true
 * detectNegation('人工智能在改变世界').negated;    // false
 * detectNegation('他不得不去').negated;            // false（双重否定）
 * detectNegation('非常高兴').negated;              // false（实词，非否定）
 * detectNegation("don't know").negated;            // true（英文缩写）
 * detectNegation('他未来').negated;                // false（默认保守：按时间名词）
 * detectNegation('他未来', { negations: ['未来'] }).negated; // true（按领域覆盖）
 * ```
 */
export function detectNegation(text: string, lexicon?: NegationLexicon): Negation {
  const { negations, nonNegations } = mergeLexicon(lexicon);
  const marks: NegationMark[] = [];

  // 英文：按词扫描，避免 notice 命中 not、none 命中 no
  for (const { segment, index } of en().segment(text)) {
    if (!/^[A-Za-z]/.test(segment)) continue;
    const lower = segment.toLowerCase();
    if (ENGLISH_NEGATION_WORDS.has(lower) || lower.endsWith(ENGLISH_NEGATION_SUFFIX)) {
      marks.push({ at: index, word: segment });
    }
  }

  // 中文：从每个**词起点**做最长匹配
  //
  // 为什么不用「分词结果整词匹配」：分词器切法不稳定，
  // `无限制套餐` 会被切成 ["无","限制","套餐"]，仅匹配整词就漏掉了「无限制」的保护。
  // 从词起点做最长匹配，既保留了词边界（不会在词内误命中），
  // 又不依赖分词器恰好切出那个长度。
  // 中文：在每个**词**的范围内顺序扫描（词边界由分词器给出）
  //
  // 为什么不是「整词匹配」或「全局最长匹配」：
  // - 整词匹配依赖分词器恰好切出那个长度。`无限制套餐` 被切成
  //   ["无","限制","套餐"]，仅匹配整词就漏掉了「无限制」的白名单保护。
  // - 全局最长匹配会漏掉同一词内的第二个否定词，
  //   `不得不`（双否定 → 肯定）只会数出一个「不」。
  // 把相邻的汉字 token 合并成连续区间：中文否定词常跨分词器的切分点，
  // 例如 `无限制套餐` 被切成 ["无","限制","套餐"]，「无限制」就跨了两个 token。
  const hanSpans: Array<{ start: number; end: number }> = [];
  for (const { segment, index } of zh().segment(text)) {
    if (!HAN_PATTERN.test(segment)) continue;
    const end = index + segment.length;
    const last = hanSpans[hanSpans.length - 1];
    if (last && last.end === index) last.end = end;
    else hanSpans.push({ start: index, end });
  }

  for (const { start, end } of hanSpans) {
    let i = start;
    while (i < end) {
      // 匹配长度不受 token 边界限制，但不超过整个汉字区间
      const maxLen = Math.min(MAX_NEGATION_WORD_LENGTH, end - i);
      // 白名单优先：命中则整段跳过（「未来」「无锡」这类不是否定）
      let guarded = 0;
      for (let len = maxLen; len >= 1; len--) {
        if (nonNegations.has(text.substr(i, len))) {
          guarded = len;
          break;
        }
      }
      if (guarded > 0) {
        i += guarded;
        continue;
      }
      // 否定词：最长优先
      let hit = '';
      for (let len = maxLen; len >= 1; len--) {
        if (negations.has(text.substr(i, len))) {
          hit = text.substr(i, len);
          break;
        }
      }
      if (hit) {
        marks.push({ at: i, word: hit });
        i += hit.length;
      } else {
        i += 1; // 本字不是否定词，继续往后找（否则「不得不」只会数一次）
      }
    }
  }

  return { marks, negated: marks.length % 2 === 1 };
}

export function negationsConflict(a: Negation, b: Negation): boolean {
  return a.negated !== b.negated;
}
