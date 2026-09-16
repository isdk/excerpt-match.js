import type { MatchOptions } from './types';

/**
 * 预设档位。
 *
 * @remarks
 * 25 个配置项里，绝大多数是「按场景决定」的，不该每次调用都重新想一遍。
 * 三档预设把它们收敛成一次选择，**显式传入的选项永远覆盖预设**。
 *
 * | 档位 | 适用 | 核心取舍 |
 * |---|---|---|
 * | {@link STRICT} | 引用校验 / 取证 | 宁可漏，不可错。只走 T0–T2 |
 * | {@link DEFAULT_PRESET} | 高亮 / 锚定 / 笔记 | 平衡，允许 T3 近似 |
 * | {@link LOOSE} | 查重 / 召回 | 尽量命中，靠 `score` 排序 |
 *
 * @example
 * ```ts
 * locateExcerpt(ex, page, { preset: 'strict' });
 * // 需要微调时，显式项覆盖预设
 * locateExcerpt(ex, page, { preset: 'loose', ignorePunctuation: false });
 * ```
 */
export type PresetName = 'strict' | 'default' | 'loose';

/**
 * 严格档：引用校验 / 取证。
 *
 * @remarks
 * 设计原则是**误判代价远高于漏判** —— 把这页说成摘录的出处，
 * 而实际上不是，比漏掉一次命中严重得多。
 *
 * 关键取舍：
 * - `allowSegmented: false` —— 分段锚点会跨过省略号拼接，
 *   短锚点可能在长文里拼出荒谬的 span
 * - `maxCrossBlocks: 1` —— 引用不该跨段
 * - `checkPolarity: true` —— 拦住「意思相反但字面相近」的摘录
 * - 不注入 `fallbacks`，因此**绝不会**有模糊匹配
 */
export const STRICT: MatchOptions = {
  // 只做无损归一
  ignoreCase: true,
  ignoreWidth: true,
  ignorePunctuation: false, // 中文标点载义：不，是 ≠ 不是
  ignoreParticles: false, // 的/地/得：宁可漏判也不误判
  numberGrouping: true, // 1,000 ≡ 1000：纯记法差异，无损
  groupingUnderscore: false,
  cjkNumerals: false, // 换数词系统，有语义歧义
  splitCamelCase: false,
  normalizeIdentifierSeparators: false,

  // 限定在单段内
  allowSegmented: false,
  allowCrossBlock: false,
  maxCrossBlocks: 1,

  // 精确优先：不修剪、补齐标记
  trimMarkdownEdges: false,
  expandMarkers: true,

  // 极性守卫
  checkPolarity: true,

  // 无 fallbacks → T0–T2 之外绝不命中
  fallbacks: [],
};

/**
 * 默认档：高亮 / 锚定 / 笔记。
 *
 * @remarks
 * 落在严格与宽松之间：接受常见的复制误差（标点差异、跨段），
 * 但**默认不开启**那些会改变词义的宽松选项。
 */
export const DEFAULT_PRESET: MatchOptions = {
  ignoreCase: true,
  ignoreWidth: true,
  ignorePunctuation: false,
  ignoreParticles: false,
  numberGrouping: true,
  groupingUnderscore: false,
  cjkNumerals: false,
  splitCamelCase: false,
  normalizeIdentifierSeparators: false,

  allowSegmented: true, // 人工摘引常用「……」
  allowCrossBlock: true,
  maxCrossBlocks: Infinity, // 只强制连续，不限段数

  trimMarkdownEdges: false,
  expandMarkers: true,

  checkPolarity: true,
  minSegmentLength: 4,

  // fallbacks 由调用方注入 —— 未注入则等价于严格档加分段/跨块
  fallbacks: [],
};

/**
 * 宽松档：查重 / 召回。
 *
 * @remarks
 * 目标是**尽量命中**，然后靠 `score` + `kind` 排序，由调用方决定阈值。
 *
 * 与默认档的差别：
 * - `ignorePunctuation: true` —— 标点差异一律忽略
 * - `allowCrossBlock` + `maxCrossBlocks: Infinity`
 * - `minFallbackScore: 0.6` —— 放宽近似层门槛
 *
 * **注意**：本档**不会**自动注入 `fallbacks`。模糊匹配需要外部库
 * （`diff-match-patch-es`），库的存在与否不该由预设隐式决定 ——
 * 请显式传入，否则本档只比默认档多了标点忽略。
 */
export const LOOSE: MatchOptions = {
  ignoreCase: true,
  ignoreWidth: true,
  ignorePunctuation: true, // 宽松
  ignoreParticles: false, // 仍不折叠：助词混用是错字，不是语义等价
  numberGrouping: true,
  groupingUnderscore: true, // 宽松：1_000 ≡ 1000
  cjkNumerals: false, // 仍关闭：异文收敛是假命中来源
  splitCamelCase: false,
  normalizeIdentifierSeparators: true, // 宽松：tensor_flow ≡ TensorFlow

  allowSegmented: true,
  allowCrossBlock: true,
  maxCrossBlocks: Infinity,

  trimMarkdownEdges: false,
  expandMarkers: true,

  checkPolarity: true,
  minSegmentLength: 3,
  minFallbackScore: 0.6,

  fallbacks: [],
};

/** 按名字取预设 */
const BY_NAME: Record<PresetName, MatchOptions> = {
  strict: STRICT,
  default: DEFAULT_PRESET,
  loose: LOOSE,
};

/**
 * 把预设与显式选项合并，**显式项优先**。
 *
 * @remarks
 * 两个细节：
 *
 * 1. **不修改入参** —— 返回新对象
 * 2. `fallbacks` 特殊处理：预设给的是空数组，若调用方显式传了就用调用方的；
 *    若没传且预设也是空，则**不写入**，让下游的默认值生效
 *
 * @param options 调用方传入的选项
 * @returns 合并后的选项；未指定 `preset` 时原样返回
 */
export function withPreset(options: MatchOptions = {}): MatchOptions {
  const { preset, ...rest } = options;
  if (!preset) return options;
  const base = BY_NAME[preset];
  if (!base) {
    throw new Error(
      `未知 preset: ${preset}（可选：strict / default / loose）`
    );
  }
  return { ...base, ...rest };
}
