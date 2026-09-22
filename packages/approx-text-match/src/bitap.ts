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
 * 挑一段「在原文里出现次数最少」的种子。Bitap/模糊搜索对长 pattern 有上限，
 *  用短种子定位再扩展，比直接扔长串进去更稳（seed-and-extend）。
 *
 * **毒化种子**：摘录里混着文档侧不存在的字符时（md 标记 `**`、被压坏的列表序号、
 * OCR 噪声……），含它们的窗口在原文里出现 0 次。「出现 0 次」不是「最稀有」——
 * 稀有但**存在**的种子才能当锚点，根本不存在的只会让 Bitap 空手而归。
 * 因此 count=0 的窗口永不胜出，只在所有窗口都找不到时留作备胎
 * （按「有多少字符在原文里出现过得比较」择优，字符集惰性构建 —— 常规路径零开销）。
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

/** 归一化操作码：0 = 相同, -1 = 页面多出, 1 = 摘录多出 */
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
   * @returns 命中区间列表；`null` 表示未命中
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
  /** Bitap 匹配阈值，0 = 完美匹配，1 = 很宽松 */
  threshold?: number;
  /** 期望匹配位置附近多远的范围内搜索 */
  distance?: number;
  /** 种子左右各开多大的窗口供 diff 精修 */
  slack?: number;
  /** 出现在 {@link ExcerptMatch.via} 上的名字 */
  name?: string;
}

/**
 * 用「Bitap 定位 + diff 精修」组装一个 T3 模糊匹配器。
 *
 * **算法（seed-and-extend）**：
 * 1. 从摘录里挑一段「在页面中出现次数最少」的种子 —— Bitap 对 pattern
 *    长度有 32 位上限，长摘录直接扔进去会抛 `Pattern too long`。
 *    「出现 0 次」的毒化窗口（混入页面不存在的标记字符）不当锚点，见 {@link pickSeed}
 * 2. 用 Bitap 在全文里模糊定位这颗种子。种子定位不到精确落点时
 *    `loc` 退化为 0，proximity 惩罚可能压过默认阈值 —— 适配层据此放宽重试
 *    （`createDmpEsFallback` / `createDmpFallback`，两个后端行为一致）
 * 3. 以它为原点开窗口，跑序列比对精修起止边界并打分
 *
 * @remarks
 * 踩过的坑：直接累加 DELETE 段做分母，会把窗口尾部无关内容算进去，
 * 长窗口下把分数压到 0（中文漏字用例实测 0.63）。这里只统计
 * 「首个共同段 → 末个共同段」的跨度，同一用例 0.875。
 *
 * @param match Bitap 定位器
 * @param diff 序列比对器
 * @param options 阈值与窗口配置
 * @returns 近似定位器
 */
/**
 * 默认窗口余量：种子两侧各开多少字符供 diff 精修。
 *
 * 要足够大以容纳「摘录比种子长的部分」与少量增删，
 * 但过大会把无关内容算进 diff 分母压低分数（见下方评分说明）。
 */
const DEFAULT_SLACK = 64;

export function createBitapFallback(
  match: BitapMatcher,
  diff: Differ,
  options: BitapFallbackOptions = {}
): ApproxMatcher {
  const slack = options.slack ?? DEFAULT_SLACK;
  const name = options.name ?? 'bitap';

  return {
    name,
    find(needle: string, hay: string): ApproxMatch[] | null {
      if (needle.length < 2) return null;
      const seed = pickSeed(hay, needle);
      if (!seed) return null;

      const loc = Math.max(0, hay.indexOf(seed.seed));
      let pos: number;
      try {
        pos = match(hay, seed.seed, loc);
      } catch {
        pos = loc; // Bitap 拒绝（pattern 过长等）→ 退回精确位置，靠后面的 diff 兜底
      }
      if (pos < 0) return null;

      // 以种子位置为原点开窗口，向左回退种子在 needle 中的偏移，右侧留 slack
      const winStart = Math.max(0, pos - seed.offset - Math.floor(slack / 2));
      const winEnd = Math.min(hay.length, pos - seed.offset + needle.length + slack);
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
          wi += text.length; // 页面多出来的字
        }
        // op === 1：摘录多出来的字，不占窗口
      }
      if (first < 0) return null;
      const score = charF1(common, last - first, needle.length);
      if (score <= 0) return null;
      return [{ start: winStart + first, end: winStart + last, score }];
    },
  };
}

// #endregion
