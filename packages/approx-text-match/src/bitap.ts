/**
 * 近似子串定位：**给一段模式，在长文本里找出最相似的连续区间 + 相似度**。
 *
 * @remarks
 * 这是本包存在的理由 —— 现成的模糊搜索库（Fuse / fuzzysort / SymSpell）
 * 回答的是「哪些字符匹配上了」，而这里要的是「命中哪一段」：
 *
 * ```
 * fuzzysort : indexes = [0,1,2,3, 5,6,7,8,9, 12..17]   分散的匹配字符
 * Fuse.js   : matches = [[0,3],[5,9],[12,17]]           分散片段
 * 本包      : { start: 0, end: 18, score: 0.909 }       连续区间 ✅
 * ```
 *
 * 前者推不出后者：模糊搜索**跳过**的不匹配字符（上例的标点位 4/10/11）
 * 在后者里**必须包含在区间内**，否则高亮会缺字。
 *
 * @packageDocumentation
 */

// #region 小工具

/**
 * 挑一段「在原文里出现次数最少」的种子。
 *
 * ## 为什么要有种子
 *
 * Bitap 用位运算匹配，pattern 长度有 32 位硬上限，长摘录直接扔进去会抛
 * `Pattern too long`。所以先派一段短"探子"去定位，再开窗扩展
 * （seed-and-extend）。种子最长 `maxLen`（默认 24）个字符。
 *
 * ## 好种子的标准：唯一
 *
 * 种子是**锚点**，价值在于唯一性：出现 50 次等于没定位，出现 1 次一击必中。
 * 所以直觉规则是「挑出现次数最少的」。
 *
 * ## ⚠️ 陷阱：0 次不是最稀有，是不存在
 *
 * 摘录常常不是原文的原样复制，会混进**原文根本没有的字符**：
 * markdown 的 `**`、被压坏的列表序号、OCR 认错的异体字、复制粘贴带的零宽字符……
 * 一个窗口只要含有这种字符，它在原文里的出现次数**必然是 0**。
 *
 * 但「0 次」≠「最稀有」。就像在词典里查一个词返回 0 条 ——
 * 那不是定位精准，是**打错字了**。Bitap 拿着一个原文里不存在的串去找，
 * 只会返回 -1，整条摘录定位失败。行话里把这种窗口叫**毒化种子**。
 *
 * ## 因此真正的规则
 *
 * > **先问存不存在，再问稀不稀有。**
 * > 挑的是「**非零**最少出现次数」的窗口。
 *
 * - `count > 0` 的窗口**永远赢过** `count === 0` 的，哪怕后者"更少"；
 * - 只有在**所有**窗口都找不到时，才退而求其次用 0 次的当**备胎**
 *   （摘录被污染得很均匀时，可能真的一颗干净种子都挑不出来，
 *   此时"中毒轻、Bitap 还能勉强糊上去"的那颗比直接放弃强）；
 * - 备胎之间不比稀有度（都是 0，分不出高下），改比**中毒程度** `present`
 *   = 窗口里有几个字符在原文里出现过。`**甲方**应当` 里 `甲/方/应/当` 都在原文
 *   字符集里，`present = 4`，毒得轻；`〇〇甲方〇〇` 只有 2，毒得重。前者优先。
 *
 * ## 这条防线值多少（反事实）
 *
 * ```
 * hay    = 甲方应当按照合同约定支付货款，逾期支付的应当支付违约金。
 * needle = **甲方**应当按照合同约定支付货款
 *
 * 候选窗口        count   判定
 * **甲方**应当      0     毒化 → 备胎（present = 4）
 * 甲方**应当按照    0     毒化 → 备胎（present = 6）
 * 应当按照合同      1     ✅ 真实锚点，顶掉所有 0 次的，break
 * ```
 *
 * 不设这条防线 → 选中 `**甲方**应当` → Bitap 返回 -1 → **整条摘录定位失败**；
 * 而摘录里明明有 `应当按照合同` 是能命中的。
 *
 * ## 实现备注
 *
 * - `hayChars` 惰性构建：`new Set(hay)` 对大文档是 O(n)，而绝大多数情况根本
 *   遇不到 0 次窗口，所以只在真的踩到毒化种子时才 `??=` 建一次，常规路径零开销。
 * - 种子长度 < 4 直接跳过（太短没有区分度，满地都是）。
 * - 最多试 `min(5, ...)` 个候选位置，均匀撒在摘录上；一旦数到 `count <= 1`
 *   （几乎唯一）立刻 `break`，不再浪费次数。
 * - 计数到 20 就收手：够判断"稀有 vs 遍地都是"，不必数完。
 *
 * @param hay 被搜索的长文本（原文）
 * @param needle 待查找的片段（摘录）
 * @param maxLen 种子最大长度
 * @returns 种子文本 + 它在 needle 中的偏移；`null` 表示挑不出来
 */
export function pickSeed(hay: string, needle: string, maxLen = 24): { seed: string; offset: number } | null {
  if (needle.length === 0) return null;
  const len = Math.min(maxLen, needle.length);
  let best: { seed: string; offset: number; count: number; present: number } | null = null;
  // 惰性字符集：只有真的出现「全文都找不到的种子」时才建（大文档 O(n)，常规路径不付）
  let hayChars: Set<string> | null = null;
  const tries = Math.min(5, needle.length - len + 1);
  for (let k = 0; k < tries; k++) {
    const offset = tries === 1 ? 0 : Math.floor((k * (needle.length - len)) / (tries - 1));
    const seed = needle.slice(offset, offset + len);
    if (seed.length < 4) continue;
    let count = 0;
    let at = hay.indexOf(seed);
    while (at >= 0 && count < 20) {
      count++;
      at = hay.indexOf(seed, at + 1);
    }
    if (count > 0) {
      // 真实存在的锚点永远胜过任何「全文都没有」的窗口
      if (!best || best.count === 0 || count < best.count) {
        best = { seed, offset, count, present: len };
        if (count <= 1) break;
      }
      continue;
    }
    hayChars ??= new Set(hay);
    let present = 0;
    for (let i = 0; i < seed.length; i++) if (hayChars.has(seed[i])) present++;
    if (!best || (best.count === 0 && present > best.present)) {
      best = { seed, offset, count, present };
    }
  }
  return best ? { seed: best.seed, offset: best.offset } : null;
}

/** F1 风格的字符级相似度，比纯比例更抗长度差 */
function charF1(common: number, a: number, b: number): number {
  if (a + b === 0) return 0;
  return (2 * common) / (a + b);
}

// #endregion

// #region T3：Bitap + 序列比对

/**
 * 归一化操作码：0 = 相同, -1 = 页面多出, 1 = 摘录多出。
 *
 * 这里的「页面」= `hay`（被搜索的原文），「摘录」= `needle`。
 * 两者同义混用是历史遗留，看到时按 hay / needle 理解即可。
 */
export type DiffOp = 0 | -1 | 1;

/**
 * 一次近似定位的结果。
 *
 * @remarks
 * **`end - start` 一定包含中间未匹配的字符** —— 这是"区间"而非"匹配字符集合"
 * 的本质差别。高亮时直接 `text.slice(start, end)` 即可，不会缺字。
 */
export interface ApproxMatch {
  /** 命中区间起点（含） */
  start: number;
  /** 命中区间终点（不含） */
  end: number;
  /** 相似度，0~1 */
  score: number;
}

/** 一段 diff 结果 */
export interface DiffChunk {
  op: DiffOp;
  text: string;
}

/**
 * 近似定位器 —— 在大文本中找出近似子串的**位置**。
 *
 * @remarks
 * 这是整个 T3 的**能力核心**，也是选型时最该看的东西。
 * 注意它和「计算两个字符串的差异」是完全不同的能力：
 * jsdiff / @lowlighter/diff 只有后者，没有这个。
 *
 * 输入输出都是**纯字符串下标** —— 这是刻意的：本包不关心坐标映射，
 * 只回答"哪一段最像"。调用方（如需要高亮到原文）再自行换算。
 */
export interface ApproxMatcher {
  /** 实现方名称，便于出现在日志里排查 */
  readonly name: string;
  /**
   * @param needle 待查找的片段
   * @param hay 被搜索的长文本
   * @returns 命中区间列表，**按分数降序**；`null` 表示未命中
   *
   * @remarks
   * 列表长度默认恒为 1（"只给最像的那一处"，与历史行为一致）。
   * 要拿多处命中，构造时传 {@link BitapFallbackOptions.maxMatches}。
   */
  find(needle: string, hay: string): ApproxMatch[] | null;
}

export type BitapMatcher = (text: string, pattern: string, loc: number) => number;

/**
 * 序列比对器 —— 精修边界用。
 *
 * @remarks
 * 只要能返回「哪些片段相同、哪些是各自多出来的」就行，
 * 因此 dmp 的 `diff_main` 与任何 Myers 实现都能套进来。
 */
export type Differ = (a: string, b: string) => Iterable<DiffChunk>;

export interface BitapFallbackOptions {
  /**
   * Bitap 匹配阈值，0 = 完美匹配，1 = 很宽松。
   *
   * ⚠️ 维护提示：`createBitapFallback` 目前只消费 `slack` 与 `name`，
   * **`threshold` / `distance` 不在这里读** —— 它们是给构造 `match` 的适配层
   * （`createDmpEsFallback` / `createDmpFallback`）准备的。改这两个值前先确认
   * 适配层是否真的消费了，否则会出现"改了没效果"。
   */
  threshold?: number;
  /** 期望匹配位置附近多远的范围内搜索（同上，由适配层消费） */
  distance?: number;
  /** 种子左右各开多大的窗口供 diff 精修 */
  slack?: number;
  /** 出现在 {@link ExcerptMatch.via} 上的名字 */
  name?: string;
  /**
   * 最多返回几个命中，**默认 1** —— 即"只给最像的那一处"，与历史行为一致。
   *
   * 调大它才能找出"同一摘录在长文里的多处近似出现"。
   * 实现方式是**遮蔽已命中区间后重新定位**（Bitap 一次只返回一个位置），
   * 每轮都要重建一次字符串，开销 O(maxMatches × hay.length)。
   *
   * ⚠️ 强烈建议同时设 {@link BitapFallbackOptions.minScore}：
   * Bitap 是模糊的，第 2、第 3 个命中的分数会明显低于第 1 个
   * （实测：正确命中 0.9 量级，错误位置只有 0.135）。不设门槛的话，
   * 列表尾部基本是噪声。
   */
  maxMatches?: number;
  /**
   * 命中的最低分数门槛，低于它的**直接终止搜索**（不是跳过）；
   * **默认 0**，即只排除 score <= 0，与历史行为完全一致。
   *
   * 因为 Bitap 大致按"从好到差"的顺序吐位置，一旦低于门槛，
   * 后面的只会更差，所以这里是 `break` 而非 `continue`。
   */
  minScore?: number;
}

/**
 * 默认窗口余量：以种子命中点为原点，左右各开多少字符供 diff 精修。
 *
 * 要足够大以容纳「摘录比种子长的部分」与少量增删，
 * 但过大会把无关内容算进 diff 分母压低分数（见 {@link createBitapFallback} 的评分说明）。
 *
 * 注意：`const` 必须待在下面的 JSDoc **之前** —— 否则那段 `@param / @returns`
 * 会与函数体分离成"悬浮注释"，文档工具不会把它挂到 `createBitapFallback` 上。
 */
const DEFAULT_SLACK = 64;

/** 默认最多返回几个命中 —— 1 即"只给最像的那一处"，与历史行为一致 */
const DEFAULT_MAX_MATCHES = 1;

/** 默认分数门槛 —— 0 即只排除 score <= 0，与历史行为一致 */
const DEFAULT_MIN_SCORE = 0;

/**
 * 挑一个「不在 hay 也不在 needle 里」的字符当遮蔽哨兵。
 *
 * 遮蔽已命中区间时要用它填充。若哨兵恰好是正文里存在的字符，
 * 它会作为正常字符参与 Bitap 匹配，遮蔽就失效了 —— 所以必须挑一个没出现过的。
 *
 * 只在 {@link BitapFallbackOptions.maxMatches} > 1 时才会被调用（建 Set 是 O(n)），
 * 单命中的默认路径零开销。
 */
function pickSentinel(hay: string, needle: string): string {
  const used = new Set<string>();
  for (const ch of hay) used.add(ch);
  for (const ch of needle) used.add(ch);
  // 先试几个几乎不可能出现在正文里的控制符 / 私用区码位
  for (const cand of ['\u0000', '\u0001', '\u0002', '\uE000', '\u2603']) {
    if (!used.has(cand)) return cand;
  }
  // 兜底：线性扫 BMP（跳过代理区）
  for (let code = 0; code < 0xd800; code++) {
    const ch = String.fromCharCode(code);
    if (!used.has(ch)) return ch;
  }
  return '\u0000'; // 到不了：正文不可能占满 55296 个码点
}

/**
 * 把若干区间替换成**等长**的哨兵串。
 *
 * 等长是关键：下标不变，所以在"遮蔽文本"上算出的 `pos`
 * 可以直接拿去切**原始 hay** 做 diff 精修。
 */
function maskSpans(hay: string, spans: Array<[number, number]>, sentinel: string): string {
  let out = hay;
  for (const [from, to] of spans) {
    if (to <= from) continue;
    out = out.slice(0, from) + sentinel.repeat(to - from) + out.slice(to);
  }
  return out;
}

/**
 * 用「Bitap 定位 + diff 精修」组装一个 T3 模糊匹配器。
 *
 * **算法（seed-and-extend）**：
 * 1. 从摘录里挑一段「在原文中出现次数最少」的种子 —— Bitap 对 pattern
 *    长度有 32 位上限，长摘录直接扔进去会抛 `Pattern too long`。
 *    「出现 0 次」的毒化窗口（混入原文不存在的标记字符）不当锚点，见 {@link pickSeed}
 * 2. 用 Bitap 在全文里模糊定位这颗种子。种子定位不到精确落点时
 *    `loc` 退化为 0，proximity 惩罚可能压过默认阈值 —— 适配层据此放宽重试
 *    （`createDmpEsFallback` / `createDmpFallback`，两个后端行为一致）
 * 3. 以它为原点开窗口，跑序列比对精修起止边界并打分
 *
 * @remarks
 * **评分为什么用「跨度」而不是累加 DELETE**（踩过的坑）：
 *
 * 分母必须是 `last - first`（首个共同段 → 末个共同段之间的窗口跨度），
 * 不能是所有 DELETE 段长度之和。区别在于：窗口尾部那些跟摘录无关的原文
 * （下例的「，应当赔偿。」）会被 DELETE 累加进分母，长窗口下分数被压到 0
 * （中文漏字用例实测：累加 DELETE 得 0.63，用跨度得 0.875）。
 *
 * ```
 * window = 本院认为，被告的行为已经构成根本违约，应当赔偿。
 * needle = 本院认为被告的行为构成根本违约
 *
 * 共同段   本院认为(4) 被告的行为(5) 构成(2) 根本违约(4)  → common = 15
 * 跨度     first = 0, last = 18   （夹进来的「，」「已经」共 3 字）
 * 分数     2×15 / (18 + 15) = 0.909
 * ```
 *
 * 另外 `op === 1`（摘录多出来的字）不推进窗口指针 `wi` —— 原文里压根没有这些字，
 * 不该占跨度；只有 `op === -1`（原文多出来的字）才推进。
 *
 * **多命中（{@link BitapFallbackOptions.maxMatches} > 1）怎么做的**：
 *
 * Bitap 一次只返回一个位置，所以找第 N 个命中靠**遮蔽后重新定位**：
 * 把已命中区间替换成等长哨兵串（见 {@link maskSpans}），遮蔽区因含哨兵
 * 而匹配不上，Bitap 自然去别处找。两个要点：
 *
 * 1. **遮蔽文本只用于定位，diff 精修必须切原始 hay** —— 否则窗口里全是哨兵，
 *    `common` 归零。下标等长替换，两边可以直接互用。
 * 2. 若新一轮命中的区间与已有结果重叠，说明 Bitap 又糊回了原处，
 *    此时封掉**整个窗口**再试，而不是只封命中区。
 *
 * @param match Bitap 定位器
 * @param diff 序列比对器
 * @param options 阈值与窗口配置（`slack` 默认 {@link DEFAULT_SLACK}，
 *   `maxMatches` 默认 {@link DEFAULT_MAX_MATCHES}，`minScore` 默认 {@link DEFAULT_MIN_SCORE}）
 * @returns 近似定位器；`find` 返回的结果**按分数降序**，因此 `out[0]` 恒为最佳命中
 */
export function createBitapFallback(
  match: BitapMatcher,
  diff: Differ,
  options: BitapFallbackOptions = {}
): ApproxMatcher {
  const slack = options.slack ?? DEFAULT_SLACK;
  const name = options.name ?? 'bitap';
  const maxMatches = Math.max(1, Math.floor(options.maxMatches ?? DEFAULT_MAX_MATCHES));
  const minScore = options.minScore ?? DEFAULT_MIN_SCORE;

  return {
    name,
    find(needle: string, hay: string): ApproxMatch[] | null {
      if (needle.length < 2) return null;
      const seed = pickSeed(hay, needle);
      if (!seed) return null;

      const results: ApproxMatch[] = [];
      // 已"占用"的区间：命中过的记 [start,end)，重叠被拒的记整个窗口
      const masked: Array<[number, number]> = [];
      // 哨兵惰性计算 —— 单命中（默认）根本用不到，不付 O(n) 的代价
      let sentinel: string | null = null;
      // 迭代上限：每轮都可能因「与已有结果重叠」而白跑一次，给点余量防死循环
      const maxAttempts = maxMatches * 4;

      for (let attempt = 0; attempt < maxAttempts && results.length < maxMatches; attempt++) {
        // 多命中时搜索的是**遮蔽文本**；单命中（默认）就是原文，行为与旧版完全一致
        const searchText =
          masked.length === 0 ? hay : maskSpans(hay, masked, (sentinel ??= pickSentinel(hay, needle)));
        // loc 每轮重算：遮蔽之后种子的精确落点会变
        const loc = Math.max(0, searchText.indexOf(seed.seed));
        let pos: number;
        try {
          pos = match(searchText, seed.seed, loc);
        } catch {
          pos = loc; // Bitap 拒绝（pattern 过长等）→ 退回精确位置，靠后面的 diff 兜底
        }
        if (pos < 0) break;

        // 以种子位置为原点开窗口，向左回退种子在 needle 中的偏移，右侧留 slack
        const winStart = Math.max(0, pos - seed.offset - Math.floor(slack / 2));
        const winEnd = Math.min(hay.length, pos - seed.offset + needle.length + slack);
        // ⚠️ 精修必须切**原始 hay**：searchText 里已命中的区间被哨兵覆盖了，
        //    拿它跑 diff 会让 common 归零。等长替换保证下标两边一致，可直接互用。
        const window = hay.slice(winStart, winEnd);

        // 用 diff 精修边界：只统计「首个共同段 → 末个共同段」之间的跨度。
        // 直接累加 DELETE 会把窗口尾部无关内容算进分母，长窗口下会把分数压到 0。
        let wi = 0;
        let common = 0;
        let first = -1;
        let last = 0;
        for (const { op, text } of diff(window, needle)) {
          if (op === 0) {
            if (first < 0) first = wi;
            common += text.length;
            wi += text.length;
            last = wi;
          } else if (op === -1) {
            wi += text.length; // hay 多出来的字
          }
          // op === 1：needle 多出来的字，不占窗口
        }
        if (first < 0) break;

        const score = charF1(common, last - first, needle.length);
        // 低于门槛就终止：Bitap 大致按"从好到差"吐位置，后面的只会更差
        if (score <= 0 || score < minScore) break;

        const start = winStart + first;
        const end = winStart + last;
        if (results.some((m) => start < m.end && end > m.start)) {
          // 又糊回已命中的地方：封掉整个窗口，换个地方再找
          masked.push([winStart, winEnd]);
          continue;
        }
        results.push({ start, end, score });
        masked.push([start, end]);
      }

      if (results.length === 0) return null;
      results.sort((a, b) => b.score - a.score); // 高分在前：out[0] 恒为最佳命中
      return results;
    },
  };
}

// #endregion
