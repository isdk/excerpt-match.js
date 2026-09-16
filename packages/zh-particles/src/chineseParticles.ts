/**
 * 中文结构助词「的 / 地 / 得」的判定。
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
 * 所以判定的关键不是"是不是这三个字"，而是
 * **"这个字在此处是不是独立的助词 token"**。
 *
 * ## 三种档位
 *
 * | 档位 | 说明 |
 * |---|---|
 * | `false` | 不折叠（**默认**）—— 零误判 |
 * | `true` | 内置保守模式：实词保护表，零依赖但补不全 |
 * | `ParticleTagger` | 注入分词器（如 jieba），按词性精确判定 |
 *
 * @example
 * ```ts
 * // jieba 把「土地」切成 土地/n，「地」不是独立 token，自动不被折叠
 * import * as jieba from '@isdk/nlp-jieba';
 * const tagger = createJiebaParticleTagger(jieba);
 * tagger('他高兴地接受', 3); // true（助词）
 * tagger('这片土地', 3);     // false（实词）
 * ```
 *
 * @packageDocumentation
 */

/**
 * 中文结构助词「的 / 地 / 得」的**词性感知**判定。
 *
 * ## 为什么需要词性，而不是无脑折叠
 *
 * 上一版把三者无脑折叠成「的」，实测发现严重误判：
 *
 * ```
 * 原文「辽阔的大地」 ← 摘录「辽阔的大的」     normalized 1.00  ← 误判
 * 原文「这片土地」   ← 摘录「这片土的」       normalized 1.00  ← 误判
 * 原文「值得信赖」   ← 摘录「值的信赖」       normalized 1.00  ← 误判
 * ```
 *
 * 更糟的是 `score = 1.00` —— 系统在宣称「两段文本完全一致」，而它们并不一致。
 * 在引用校验 / 取证场景下这是致命的。
 *
 * 根因是**分类错误**：全半角是「同一内容的不同表示」，
 * 而「大地」与「大的」是**两个不同的词**。前者能折叠，后者不能。
 *
 * ## 判据：jieba 的词性标注
 *
 * jieba 把这三个字标成不同助词：`uj` = 的、`uv` = 地、`ud` = 得。
 * **关键是：只有当它们作助词时才是独立 token。**
 *
 * ```
 * 他高兴地接受了 → 他/r 高兴/b 地/uv 接受/v   ← 地 是独立助词，可折叠
 * 这片土地       → 这片/x 土地/n              ← 无独立助词，不可折叠
 * 他得到了批准   → 得到/v                     ← 无独立助词，不可折叠
 * ```
 *
 * 分词器天然解决了「实词里含有的/地/得」问题 —— 因为那些字根本不是独立 token。
 *
 * @packageDocumentation
 */

/** 结构助词的词性标记（jieba / ICTCLAS 体系） */
export const PARTICLE_TAGS: ReadonlySet<string> = new Set([
  'uj', // 结构助词「的」
  'uv', // 结构助词「地」
  'ud', // 结构助词「得」
]);

/** 三个结构助词本身 */
export const PARTICLES: ReadonlySet<string> = new Set(['的', '地', '得']);

/**
 * 助词判定器：给定文本，返回**可以折叠**的字符下标集合。
 *
 * @remarks
 * 下标是相对**传入文本**的偏移。归一化层处理摊平文本时，
 * 传入的就是摊平后的可见文本 —— 坐标系天然对齐。
 *
 * 实现方应自行缓存：归一化可能被调用多次，
 * 但同一段文本的判定结果是稳定的。
 */
export interface ParticleTagger {
  /** 实现方名称，便于排查 */
  readonly name: string;
  /**
   * @param text 待判定的文本
   * @returns 可折叠的字符下标集合
   */
  foldableAt(text: string): ReadonlySet<number>;
}

/**
 * 零依赖的保守判定器：用一张**实词保护表**挡住已知危险词。
 *
 * @remarks
 * 原理：先假设所有 的/地/得 都可折叠，再把构成实词的位置排除掉。
 *
 * **局限**：这张表是无底洞。`大地 / 土地 / 地方 / 地址 / 得到 / 懂得 / 值得 /
 * 获得 / 记得 / 觉得 / 显得 / 使得 / 目的地 / 根据地 / 殖民地 / 心地 / 见地 / 境地…`
 * 手动枚举补不全。它只覆盖最高频的几十个词，作为**无 WASM 依赖时的兜底**。
 *
 * 能引入 `@isdk/nlp-jieba` 请直接用 {@link createJiebaParticleTagger}。
 */
export function createGuardListParticleTagger(extra: readonly string[] = []): ParticleTagger {
  const words = new Set<string>([...SOLID_WORDS, ...extra]);
  return {
    name: 'conservative',
    foldableAt(text: string): ReadonlySet<number> {
      // 先全部标为可折叠
      const fold = new Set<number>();
      for (let i = 0; i < text.length; i++) {
        if (PARTICLES.has(text[i])) fold.add(i);
      }
      // 再剔除构成实词的位置
      for (const w of words) {
        let at = text.indexOf(w);
        while (at >= 0) {
          for (let k = 0; k < w.length; k++) {
            if (PARTICLES.has(w[k])) fold.delete(at + k);
          }
          at = text.indexOf(w, at + 1);
        }
      }
      return fold;
    },
  };
}

/**
 * 内置实词保护表：含 的/地/得 但**不是**助词的常见词。
 *
 * @remarks
 * 只收最高频的。jieba 词典驱动的方案不需要这张表。
 */
export const SOLID_WORDS: readonly string[] = [
  // 地
  '大地', '土地', '地方', '地址', '地点', '地图', '地位', '地区', '地面', '地球',
  '地铁', '基地', '场地', '场地', '场地', '目的地', '所在地', '根据地', '殖民地',
  '心地', '见地', '境地', '内地', '外地', '本地', '实地', '原地', '场地', '工地',
  '地下', '地板', '地质', '地形', '地域', '地毯', '地道', '地铁', '地主', '地步',
  // 得
  '得到', '懂得', '值得', '获得', '记得', '觉得', '显得', '使得', '认得', '晓得',
  '舍得', '懒得', '免得', '不见得', '了不得', '不得已', '不得不', '得意', '得逞',
  '得罪', '得利', '得失', '得当', '得体', '得分', '得手', '得逞',
  // 的
  '目的', '的确', '的士', '标的', '一的', '有的是', '当家的',
  // 得（动词义）
  '得分', '得奖', '得胜', '得志', '得宠',
];

/** `@isdk/nlp-jieba` 的最小结构类型（只声明用到的成员） */
export interface JiebaLike {
  /** 加载默认词典。**必须先调用**，否则所有词性都会是 `x`（未知） */
  addDefaultDict(clear?: boolean | null): void;
  /** 词性标注 */
  tag(sentence: string, hmm?: boolean | null): Array<{ word: string; tag: string }>;
  /** 分词 + 字符偏移（用于精确定位） */
  tokenize(text: string, options?: { mode?: string | null; hmm?: boolean | null } | null): Array<{ word: string; start: number; end: number }>;
}

export interface JiebaTaggerOptions {
  /** 是否启用 HMM 新词发现。默认 true —— 专有名词、人名等未登录词需要它 */
  hmm?: boolean;
  /**
   * 超过此长度的文本不跑分词，直接返回空集合（即不折叠任何助词）。
   *
   * @remarks
   * 防御性措施：jieba 是 O(n) 但常数不小，超长文本（数 MB）会拖慢建索引。
   * 实测 tag(6000 字) ≈ 9ms，即约 1.5μs/字符。
   * @defaultValue `200000`
   */
  maxLength?: number;
}

/**
 * 基于 `@isdk/nlp-jieba`（jieba-rs 的 WASM 绑定）的精确判定器。
 *
 * **这是推荐方案**：词典驱动，不需要手工枚举保护表。
 *
 * @param jieba `@isdk/nlp-jieba` 模块
 * @param options 见 {@link JiebaTaggerOptions}
 * @returns 判定器
 *
 * @example
 * ```ts
 * import * as jieba from '@isdk/nlp-jieba';
 * const tagger = createJiebaParticleTagger(jieba);
 * locateExcerpt(ex, page, { markdown: md, ignoreParticles: tagger });
 * ```
 *
 * @remarks
 * **必须先 `addDefaultDict()`**，否则所有词性都是 `x`，判定完全失效。
 * 本函数会在首次调用时自动调用一次，所以调用方无需操心。
 *
 * 位置获取策略：`tag()` 给词性但不给偏移，`tokenize()` 给偏移但不给词性。
 * 两者分词结果一致，这里用 tokenize 的权威偏移，并校验 word 序列相同；
 * 不一致时退化为按 `tag()` 的 word 长度累加推算。
 */
export function createJiebaParticleTagger(jieba: JiebaLike, options: JiebaTaggerOptions = {}): ParticleTagger {
  const hmm = options.hmm ?? true;
  const maxLength = options.maxLength ?? 200_000;
  let ready = false;

  const ensure = (): void => {
    if (ready) return;
    jieba.addDefaultDict();
    ready = true;
  };

  return {
    name: 'jieba',
    foldableAt(text: string): ReadonlySet<number> {
      const empty: ReadonlySet<number> = new Set();
      if (text.length === 0 || text.length > maxLength) return empty;
      ensure();

      const tags = jieba.tag(text, hmm);
      if (tags.length === 0) return empty;

      // 取权威偏移：tokenize 与 tag 的切分应一致，一致才敢用
      let starts: number[] | null = null;
      try {
        const toks = jieba.tokenize(text, { mode: 'Default', hmm });
        if (toks.length === tags.length && toks.every((t, i) => t.word === tags[i].word)) {
          starts = toks.map((t) => t.start);
        }
      } catch {
        starts = null; // tokenize 不可用就走累加
      }
      if (!starts) {
        starts = [];
        let acc = 0;
        for (const t of tags) {
          starts.push(acc);
          acc += t.word.length;
        }
      }

      const fold = new Set<number>();
      for (let i = 0; i < tags.length; i++) {
        const t = tags[i];
        if (PARTICLE_TAGS.has(t.tag) && PARTICLES.has(t.word)) fold.add(starts[i]);
      }
      return fold;
    },
  };
}
