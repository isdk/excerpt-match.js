/**
 * 成熟序列比对库的适配层。
 *
 * 本包**不实现比对算法** —— 只把现有库接成统一的 {@link BitapMatcher} / {@link Differ}
 * 两个函数签名，核心算法由 {@link createBitapFallback} 编排。
 *
 * 选型标准是**能不能做模糊定位**（Bitap），而不是"谁更流行"：
 *
 * | 库 | 维护 | Bitap 定位 | 建议 |
 * |---|---|---|---|
 * | `diff-match-patch-es` | ✅ 活跃 | ✅ | **推荐** |
 * | `diff-match-patch` | ❌ 2020 停更 | ✅ | 兼容保留（`@deprecated`） |
 * | `diff`（jsdiff） | ✅ 活跃 | ❌ | **能力不匹配** |
 *
 * jsdiff 被排除不是因为它不好，而是它只有 `diffChars` 这类全量比对，
 * 做不了"在长文本里模糊定位"，用它就得自己重写 seed-and-extend。
 *
 * ## 配置项在哪一层消费
 *
 * `threshold` / `distance` 由**本层**消费（传给 Bitap）；
 * `slack` / `name` 透传给 {@link createBitapFallback}。
 * 简单记：调 `threshold` 影响「粗定位找不找得到」，
 * 调 `slack` 影响「精修窗口开多大、分数怎么算」。
 *
 * ## 放宽重试（两个后端共用，改这段代码前先读这段）
 *
 * Bitap 的评分公式（Google 原版与各移植版一致）：
 *
 * ```
 * score      = accuracy + proximity / Match_Distance
 * accuracy   = 错误字符数 / pattern.length
 * proximity  = |loc - 候选位置|
 * 命中条件    : score <= Match_Threshold      （越小越好）
 * ```
 *
 * 麻烦出在 `loc`。见 {@link pickSeed}：种子在原文里一次都不出现（毒化种子）
 * 时 `hay.indexOf(seed)` 返回 -1，于是 `loc` 被 `Math.max(0, -1)` 钳成 **0**。
 * 而真实位置可能在几千字之外 —— proximity 惩罚直接爆表：
 *
 * ```
 * 原文 3000 字，真实位置 3000，loc 被钳成 0
 * proximity 惩罚 = 3000 / 1000 = 3.0      ← 是默认阈值 0.5 的 6 倍
 * score = accuracy + 3.0                  → 无论 accuracy 多小都必然 -1
 * ```
 *
 * 关键在于：**这条惩罚是坏位置估计的产物，不代表匹配质量差**。
 * 摘录本身可能跟原文一字不差，只是我们告诉 Bitap「去第 0 个字附近找」。
 *
 * 所以两个后端都在首次 -1 后**放宽重试**，但**先判断 loc 可不可靠**
 * （判断方法就是 `text.indexOf(pattern) >= 0` —— 传给本闭包的 pattern 就是种子）：
 *
 * **A. `loc` 可靠（种子在原文里出现过）→ 渐进放宽两步**
 *
 * 1. `Match_Threshold = 1.0`，**保留** `Match_Distance`
 *    → 位置先验还在，只是不再因总分超标被拒。命中点仍受 loc 引导。
 * 2. `Match_Distance = Infinity`，彻底**摘掉** proximity 项兜底。
 *
 * 为什么不一上来就做第 2 步？因为 proximity 不只是惩罚，它还是
 * **在多个候选里挑「离 loc 最近那个」的依据**。摘掉它，Bitap 只在全文里挑
 * 字符错误最少的位置，长文本中容易挑到一处纯属巧合的片段。
 * 渐进放宽 = 尽量晚地放弃位置先验。
 *
 * **B. `loc` 不可靠（种子在原文里 0 次出现）→ 跳过第 1 步**
 *
 * ⚠️ 这是踩过的坑：曾经无条件走 A，实测在「摘录被均匀污染 + 内容位于文档
 * 中后部」的用例上返回了**完全错误的位置**：
 *
 * ```
 * 真实位置 = 1127，loc 被钳成 0，proximity 惩罚 = 1.127
 * step1（threshold=1.0，保留 proximity）→ 返回 8      ❌
 * step2（摘掉 proximity）               → 返回 1125    ✅
 * ```
 *
 * 因为 `threshold=1.0` 意味着「loc 周围 1000 字内几乎任何东西都接受」
 * （`accuracy + 8/1000 <= 1.0` → accuracy 可以烂到 0.99），
 * proximity 此刻已失去约束作用，反而让近端垃圾抢先命中；
 * 而 `if (p2 >= 0) return p2` 又让 step2 永远执行不到。
 *
 * 所以 loc 不可靠时改为：**保持阈值严格，只把 proximity 摘掉**。
 * 此时 Bitap 在全文里挑字符错误最少的位置，正是我们想要的行为。
 * 同一用例实测：8 → 1125 ✅
 *
 * @packageDocumentation
 */

import { createBitapFallback } from './bitap';
import type { ApproxMatcher, DiffChunk, DiffOp } from './bitap';

/**
 * 两个后端共用的配置。
 *
 * 分两类，别搞混消费层级：
 * - **本层消费**：`threshold` / `distance` —— 传给 Bitap，影响「粗定位找不找得到」
 * - **透传给 {@link createBitapFallback}**：`slack` / `maxMatches` / `minScore` ——
 *   影响「精修窗口开多大、返回几个、分数门槛多少」
 */
export interface AdapterOptions {
  /** Bitap 准确度门槛（accuracy = 错误字符数 / pattern 长度），0 = 严格，1 = 很宽松 */
  threshold?: number;
  /** Bitap 位置先验的搜索半径（proximity 惩罚的分母） */
  distance?: number;
  /** 种子左右各开多大的窗口供 diff 精修 */
  slack?: number;
  /** 最多返回几个命中，默认 1；> 1 时**务必**同时设 `minScore`，否则尾部全是噪声 */
  maxMatches?: number;
  /** 命中的最低分数门槛，默认 0（只排除 score <= 0） */
  minScore?: number;
}

/**
 * `diff_match_patch` 实例的最小结构类型。
 * 只声明用到的成员，避免强依赖它的类型定义（社区 `@types/diff-match-patch` 版本不一）。
 */
export interface DiffMatchPatchLike {
  Match_Threshold: number;
  Match_Distance: number;
  match_main(text: string, pattern: string, loc: number): number;
  /**
   * 返回 `[op, text]` 数组，op 编码为 -1(DELETE) / 0(EQUAL) / 1(INSERT)。
   * 这必须与 {@link DiffOp} 对齐 —— 适配层用 `as DiffOp` 断言，不做运行时校验。
   */
  diff_main(a: string, b: string): Array<[number, string]>;
}

/**
 * 基于 Google `diff-match-patch` 的 T3 模糊匹配器。
 *
 * @deprecated 该 npm 包自 2020-05 后未再发版（v1.0.5），Google 上游仓库亦已停更。
 * 新项目请用 {@link createDmpEsFallback} —— 同样的算法（含 Bitap），
 * 但是 ESM + 原生 TS 类型且仍在维护。保留此函数仅为兼容既有代码。
 *
 * @example
 * ```ts
 * import { diff_match_patch } from 'diff-match-patch';
 * const fuzzy = createDmpFallback(new diff_match_patch());
 * locateExcerpt(ex, text, { markdown: md, fallbacks: [fuzzy] });
 * ```
 */
export function createDmpFallback(
  dmp: DiffMatchPatchLike,
  options: AdapterOptions = {}
): ApproxMatcher {
  // ⚠️ 与 createDmpEsFallback 不同：那里不传就用库自己的默认（0.5），这里是 0.4。
  // 差异是历史遗留（Google 原版对阈值没那么敏感），**不要顺手"对齐"成 0.5** ——
  // 那会改变既有调用方的命中结果，属行为变更。新代码请直接用 es 版。
  const threshold = options.threshold ?? 0.4;
  const distance = options.distance ?? 1000;

  return createBitapFallback(
    (text, pattern, loc) => {
      // ⚠️ 这里改的是**实例属性**，不是参数。用 try/finally 兜住：
      // 放宽后若不还原，**最后一次调用之后**实例会永久停在放宽状态，
      // 共享同一个 dmp 实例的其他代码会静默读到"什么都算命中"的配置。
      const savedThreshold = dmp.Match_Threshold;
      const savedDistance = dmp.Match_Distance;
      try {
        dmp.Match_Threshold = threshold;
        dmp.Match_Distance = distance;
        const p = dmp.match_main(text, pattern, loc);
        if (p >= 0) return p;
        // 放宽重试（完整推导见文件头「放宽重试」小节，两个后端行为一致）。
        // 先判断 loc 可不可靠：种子在原文里一次都不出现 → loc 是被钳出来的 0
        // → proximity 惩罚是坏位置估计的产物。此时**不能**放宽阈值到 1.0
        // （那等于接受 loc 周围 1000 字内几乎任何东西，实测会抢先命中近端垃圾：
        //  真实位置 1127 却返回 8），而是保持阈值严格、只摘掉 proximity。
        if (text.indexOf(pattern) < 0) {
          dmp.Match_Distance = Number.POSITIVE_INFINITY;
          return dmp.match_main(text, pattern, loc);
        }
        dmp.Match_Threshold = 1.0;
        const p2 = dmp.match_main(text, pattern, loc);
        if (p2 >= 0) return p2;
        dmp.Match_Distance = Number.POSITIVE_INFINITY;
        return dmp.match_main(text, pattern, loc);
      } finally {
        dmp.Match_Threshold = savedThreshold;
        dmp.Match_Distance = savedDistance;
      }
    },
    (a, b) => {
      const out: DiffChunk[] = [];
      // `as DiffOp` 是**契约断言**：dmp 的 op 编码为 -1(DELETE) / 0(EQUAL) / 1(INSERT)，
      // 恰好等于 {@link DiffOp}。若上游改了编码，这里会**静默**产出错误结果 ——
      // 换库或升版时务必先核对这三个值。
      for (const [op, text] of dmp.diff_main(a, b)) out.push({ op: op as DiffOp, text });
      return out;
    },
    // threshold / distance 透传下去无害：createBitapFallback 只读 slack 与 name。
    { ...options, name: 'diff-match-patch' }
  );
}

/** `diff-match-patch-es` 的 match 选项（只列用到的两个） */
export interface DmpEsMatchOptions {
  matchThreshold?: number;
  matchDistance?: number;
}

/**
 * `diff-match-patch-es` 的最小结构类型 —— 只需两个纯函数。
 *
 * @remarks
 * 该包把 Google 的实现重写为**纯函数 + ESM + TypeScript**，
 * 算法语义（含 Bitap 模糊定位）完全保留，且仍在活跃维护。
 * 这是目前推荐的 T3 后端。
 */
export interface DmpEsLike {
  /** Bitap 模糊定位：返回 pattern 在 text 中的最佳位置，-1 = 没找到 */
  match(text: string, pattern: string, loc: number, options?: DmpEsMatchOptions): number;
  /**
   * Myers 序列比对，返回 `[op, text]` 数组。
   *
   * op 编码为 -1(DELETE) / 0(EQUAL) / 1(INSERT)，必须与 {@link DiffOp} 对齐 ——
   * 适配层用 `as DiffOp` 断言，不做运行时校验。
   * `options` 在签名里但本适配层不传（用库默认）。
   */
  diff(a: string, b: string, options?: Record<string, unknown>): Array<[number, string]>;
}

/**
 * 基于 `diff-match-patch-es` 的 T3 模糊匹配器（**推荐**）。
 *
 * 相比 `diff-match-patch`：
 * - 仍在维护（2020 年停更的那个包不是）
 * - 原生 ESM + TypeScript 类型，不需要 `@types/*`
 * - tree-shakable，只打包用到的 `match` / `diff`
 * - 算法一致，同样具备 Bitap 模糊定位能力
 *
 * @param dmpEs `diff-match-patch-es` 的模块命名空间（即 `import * as dmpEs from 'diff-match-patch-es'`）
 * @param options 阈值与窗口配置
 * @returns 可直接放进 {@link MatchOptions.fallbacks} 的匹配器
 *
 * @example
 * ```ts
 * import * as dmpEs from 'diff-match-patch-es';
 * const fuzzy = createDmpEsFallback(dmpEs);
 * locateExcerpt(ex, text, { markdown: md, fallbacks: [fuzzy] });
 * ```
 *
 * @remarks
 * 三点注意：
 * 1. 该包是**纯 ESM**（`exports` 只暴露 `.mjs`）。构建链含 CJS 环节时请先确认能否 require。
 * 2. 它对 `matchThreshold` 比原版敏感 —— 实测同一摘录在 0.4 下返回 -1、0.5 下正常。
 *    因此这里默认不传 options，直接用库的默认值。
 * 3. Bitap 首次返回 -1 时会**放宽重试**（先放宽阈值、再摘掉 proximity 惩罚）。
 *    两步的推导与取舍见**文件头「放宽重试」小节**（两个后端共用，此处不重复）。
 *    一句话版：毒化种子找不到精确落点 → `loc` 退化为 0 → proximity 惩罚爆表，
 *    而这条惩罚是坏位置估计的产物，不代表匹配质量差；放宽 Bitap 只影响窗口起点，
 *    命中与否最终由 diff 分数把关。
 */
export function createDmpEsFallback(
  dmpEs: DmpEsLike,
  options: AdapterOptions = {}
): ApproxMatcher {
  // 只在显式传入时才构造 options 对象 —— 不传就用库自己的默认（threshold 0.5）。
  // 实测：该实现对阈值比原版敏感，沿用原版 adapter 的 0.4 会让本该命中的用例返回 -1。
  const matchOpts: DmpEsMatchOptions | undefined =
    options.threshold === undefined && options.distance === undefined
      ? undefined
      : {
          ...(options.threshold !== undefined ? { matchThreshold: options.threshold } : {}),
          ...(options.distance !== undefined ? { matchDistance: options.distance } : {}),
        };

  return createBitapFallback(
    (text, pattern, loc) => {
      const p = dmpEs.match(text, pattern, loc, matchOpts);
      if (p >= 0) return p;
      // 放宽重试（完整推导见文件头「放宽重试」小节，与 createDmpFallback 行为一致）。
      // 先判断 loc 可不可靠：种子在原文里一次都不出现 → loc 是被钳出来的 0
      // → proximity 惩罚是坏位置估计的产物。此时**不能**放宽阈值到 1.0
      // （那等于接受 loc 周围 1000 字内几乎任何东西，实测会抢先命中近端垃圾：
      //  真实位置 1127 却返回 8），而是保持阈值严格、只摘掉 proximity。
      const locReliable = text.indexOf(pattern) >= 0;
      if (!locReliable) {
        return dmpEs.match(text, pattern, loc, { ...matchOpts, matchDistance: Number.POSITIVE_INFINITY });
      }
      const p2 = dmpEs.match(text, pattern, loc, { ...matchOpts, matchThreshold: 1.0 });
      if (p2 >= 0) return p2;
      return dmpEs.match(text, pattern, loc, { ...matchOpts, matchThreshold: 1.0, matchDistance: Number.POSITIVE_INFINITY });
    },
    (a, b) => {
      const out: DiffChunk[] = [];
      // `as DiffOp` 是**契约断言**：该库的 op 编码为 -1(DELETE) / 0(EQUAL) / 1(INSERT)，
      // 恰好等于 {@link DiffOp}。若上游改了编码，这里会**静默**产出错误结果。
      for (const [op, text] of dmpEs.diff(a, b)) out.push({ op: op as DiffOp, text });
      return out;
    },
    // threshold / distance 透传下去无害：createBitapFallback 只读 slack 与 name。
    { ...options, name: 'diff-match-patch-es' }
  );
}
