/**
 * 字形簇（grapheme cluster）边界。
 *
 * 全部委托给 `Intl.Segmenter`（ECMAScript 内置，Unicode UAX #29 标准实现）。
 * **不自己实现** —— ZWJ 序列、国旗、肤色修饰符、组合附加符号
 * 的规则复杂且随 Unicode 版本演进，手写必然补不全。
 *
 * @packageDocumentation
 */

/** 字形簇分段器缓存。locale 对字形簇切分无影响，故只用一个 */
let graphemeSegmenter: Intl.Segmenter | null = null;

function getGraphemeSegmenter(): Intl.Segmenter {
  return (graphemeSegmenter ??= new Intl.Segmenter('en', { granularity: 'grapheme' }));
}

export interface TextSpan {
  /** 起始下标（UTF-16 code unit） */
  index: number;
  /** 长度 */
  length: number;
}

/**
 * 把区间对齐到字形簇边界，避免切在簇中间产生乱码或缺笔。
 *
 * 覆盖了手写逻辑必然漏掉的情况：
 *
 * | 输入 | 簇数 | 手写逻辑 |
 * |---|---|---|
 * | `👨‍👩‍👧‍👦`（ZWJ 家庭） | 1 | 会切成 4 个人 + ZWJ |
 * | `🇨🇳`（区域指示符对） | 1 | 会切成两半 |
 * | `👍🏽`（肤色修饰符） | 1 | 会把肤色切出去 |
 * | `é`（e + 组合锐音符） | 1 | 可处理，但 `é`（预组合）又是另一套 |
 *
 * @param src 原文
 * @param index 起始下标
 * @param length 长度
 * @returns 对齐后的区间
 *
 * @example
 * ```ts
 * snapToGraphemeBoundary('a👨‍👩‍👧‍👦b', 2, 1); // { index: 1, length: 11 } —— 整个家庭
 * ```
 */
export function snapToGraphemeBoundary(src: string, index: number, length: number): TextSpan {
  if (src.length === 0) return { index: 0, length: 0 };
  // 先夹紧起点，再按**夹过的起点**算终点 —— 否则 (-5, 2) 会退化成 (0, 0)
  const start = Math.max(0, Math.min(index, src.length));
  const end = Math.max(start, Math.min(start + length, src.length));
  if (start === end) return { index: start, length: 0 };

  const seg = getGraphemeSegmenter();
  let snappedStart = start;
  let snappedEnd = end;
  let cursor = 0;
  for (const { segment } of seg.segment(src)) {
    const next = cursor + segment.length;
    // 起点落在簇内部（且不是簇首）→ 向前扩展到簇首
    if (start > cursor && start < next) snappedStart = cursor;
    // 终点落在簇内部（且不是簇尾）→ 向后扩展到簇尾
    if (end > cursor && end < next) snappedEnd = next;
    if (cursor >= end) break;
    cursor = next;
  }
  if (snappedEnd < start) snappedEnd = end;
  return { index: snappedStart, length: Math.max(0, snappedEnd - snappedStart) };
}

/** 文本包含的字形簇数量。用于「摘录是否过短」这类判定 */
export function countGraphemes(src: string): number {
  if (src.length === 0) return 0;
  let n = 0;
  for (const _ of getGraphemeSegmenter().segment(src)) n += 1;
  return n;
}
