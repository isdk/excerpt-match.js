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
 * @packageDocumentation
 */

import { createBitapFallback } from './bitap';
import type { ApproxMatcher, DiffChunk, DiffOp } from './bitap';

/**
 * `diff_match_patch` 实例的最小结构类型。
 * 只声明用到的成员，避免强依赖它的类型定义（社区 `@types/diff-match-patch` 版本不一）。
 */
export interface DiffMatchPatchLike {
  Match_Threshold: number;
  Match_Distance: number;
  match_main(text: string, pattern: string, loc: number): number;
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
  options: { threshold?: number; distance?: number; slack?: number } = {}
): ApproxMatcher {
  const threshold = options.threshold ?? 0.4;
  const distance = options.distance ?? 1000;

  return createBitapFallback(
    (text, pattern, loc) => {
      dmp.Match_Threshold = threshold;
      dmp.Match_Distance = distance;
      return dmp.match_main(text, pattern, loc);
    },
    (a, b) => {
      const out: DiffChunk[] = [];
      for (const [op, text] of dmp.diff_main(a, b)) out.push({ op: op as DiffOp, text });
      return out;
    },
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
  /** Myers 序列比对 */
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
 * 两点注意：
 * 1. 该包是**纯 ESM**（`exports` 只暴露 `.mjs`）。构建链含 CJS 环节时请先确认能否 require。
 * 2. 它对 `matchThreshold` 比原版敏感 —— 实测同一摘录在 0.4 下返回 -1、0.5 下正常。
 *    因此这里默认不传 options，直接用库的默认值。
 */
export function createDmpEsFallback(
  dmpEs: DmpEsLike,
  options: { threshold?: number; distance?: number; slack?: number } = {}
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
    (text, pattern, loc) => dmpEs.match(text, pattern, loc, matchOpts),
    (a, b) => {
      const out: DiffChunk[] = [];
      for (const [op, text] of dmpEs.diff(a, b)) out.push({ op: op as DiffOp, text });
      return out;
    },
    { ...options, name: 'diff-match-patch-es' }
  );
}
