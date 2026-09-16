/**
 * 文字（Unicode script）类别与「空白能不能删」的判定。
 *
 * 分类依据是**正字法**（这套文字平时用不用空格分词），
 * 而不是按 Unicode 区块粗略分组 —— 最要紧的是把 Hangul 从 CJK 里分出来。
 *
 * @packageDocumentation
 */

/**
 * 文字（script）类别。
 *
 * 分类依据是**正字法**而非 Unicode 区块粗略归组 ——
 * 尤其要把 Hangul 从 CJK 里分出来：韩文用空格分词，汉字/假名不用。
 */
export type UnicodeScript = 'han' | 'kana' | 'thai' | 'hangul' | 'latin' | 'digit' | 'other';

/**
 * 空格在某种文字里扮演的角色 —— 决定它能不能被删。
 *
 * | 角色 | 含义 | 例子 | 删了会怎样 |
 * |---|---|---|---|
 * | `ignorable` | 纯排版产物，正字法不用空格 | 汉字、假名 | 无影响 |
 * | `wordDelimiter` | 词分隔符 | 韩文、拉丁、数字 | **词边界歧义** |
 * | `boundary` | 句子/短语边界（性质≈标点） | 泰文 | **句子边界丢失** |
 *
 * @remarks
 * 判据：**删除空格是否造成边界歧义。**
 *
 * - 韩文：`아버지가 방에`(父亲走进房间) 与 `아버지 가방에`(钻进父亲的包里)
 *   删空格后是同一串 —— 助词归属彻底无法判断。实测分词器结果不同。
 * - 泰文：词连写、空格分句子。删掉后词仍能切开，
 *   但句子边界消失，等价于英文删掉句号。**这也是改变意义，所以同样保留。**
 * - 汉字/假名：实测删空格前后分词结果完全一致 —— 空格不载义，可删。
 *
 * 泰文与韩文结论相同（都保留）但理由不同，都是同一判据的产物。
 */
export type WhitespaceRole = 'ignorable' | 'wordDelimiter' | 'boundary';

export const WHITESPACE_ROLE_BY_SCRIPT: Record<UnicodeScript, WhitespaceRole> = {
  han: 'ignorable',
  kana: 'ignorable',
  thai: 'boundary',      // ≈ 标点：句子/短语边界
  hangul: 'wordDelimiter',
  latin: 'wordDelimiter',
  digit: 'wordDelimiter', // 数字间空格有意义（1 000 ≠ 1000）
  other: 'wordDelimiter', // 未知文字保守处理：不删
};

const scriptOfCache = new Map<number, UnicodeScript>();

/** 按码点判定文字类别（带缓存，归一化是逐字符热路径） */
export function unicodeScriptOf(cp: number): UnicodeScript {
  const c = scriptOfCache.get(cp);
  if (c !== undefined) return c;
  let r: UnicodeScript = 'other';
  if (cp >= 0x30 && cp <= 0x39) r = 'digit';
  else if (cp >= 0x0e00 && cp <= 0x0e7f) r = 'thai';
  else if (cp >= 0x3040 && cp <= 0x30ff) r = 'kana';
  else if (
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xf900 && cp <= 0xfaff)
  ) r = 'han';
  else if (cp >= 0xac00 && cp <= 0xd7af) r = 'hangul';
  else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f)) r = 'latin';
  scriptOfCache.set(cp, r);
  return r;
}

/**
 * 判断某个位置上的空白能否删除。
 *
 * 规则：
 * 1. **跨文字** → 删除。脚本边界上的空白是排版产物
 *    （`中文 AI`、`สัญญา TensorFlow` 里的空格都可有可无）。
 * 2. **同文字** → 看该文字的 {@link SpaceRole}：
 *    只有 `ignorable`（汉字/假名）才删；`wordDelimiter` 与 `boundary` 一律保留。
 */
export function canDropSpaceBetween(left: UnicodeScript, right: UnicodeScript): boolean {
  if (left === 'other' || right === 'other') return false; // 未知保守
  if (left !== right) return true; // 跨文字：排版产物
  return WHITESPACE_ROLE_BY_SCRIPT[left] === 'ignorable';
}
