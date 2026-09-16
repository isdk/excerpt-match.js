/**
 * 按语义边界把长文本切成段落。
 *
 * @remarks
 * 语义检索只需要**段落级**召回 —— 精确定位交给段内对齐。
 * 这也是 `maxLen` 默认给到 300 而不是更小的原因：段太碎会丢失上下文，
 * 段太长则召回粒度不够。
 *
 * @packageDocumentation
 */

/** 一个段落 */
export interface Segment {
  /** 段落文本 */
  text: string;
  /** 在输入文本中的起始下标 */
  start: number;
}

/**
 * 空行，或句子结束符之后。
 *
 * `\u0001` 是上游归一化的空白占位符 —— 句子结束符后面常跟它，
 * 一起吃掉才能切干净。
 */
const SEGMENT_BOUNDARY = /\n{1,}|(?<=[。！？；.!?;])\u0001*/;

/**
 * 按空行 / 句子结束符切段。
 *
 * @param text 待切分的文本
 * @param maxLen 单段最大长度，超长会继续切
 * @returns 段落列表，含各自在 `text` 中的起始下标
 *
 * @example
 * ```ts
 * splitSegments('第一句。第二句。');
 * // → [{ text: '第一句。', start: 0 }, { text: '第二句。', start: 4 }]
 * ```
 */
export function splitSegments(text: string, maxLen = 300): Segment[] {
  if (!text) return [];
  const rough = text.split(SEGMENT_BOUNDARY);
  const out: Segment[] = [];
  let cursor = 0;
  for (const part of rough) {
    if (!part) continue;
    const at = text.indexOf(part, cursor);
    const start = at >= 0 ? at : cursor;
    cursor = start + part.length;
    let s = 0;
    while (s < part.length) {
      const len = Math.min(maxLen, part.length - s);
      out.push({ text: part.slice(s, s + len), start: start + s });
      s += len;
    }
  }
  // 边界符未命中（如纯空格文本）时兜底成整段，避免返回空
  return out.length > 0 ? out : [{ text, start: 0 }];
}
