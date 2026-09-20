/**
 * 数字记法归一 —— 把「同一个数值的不同写法」收敛成一种。
 *
 * ## 管辖范围：只管**表示法**，不管**数词系统**
 *
 * | 形式 | 性质 | 默认 |
 * |---|---|---|
 * | `1,000` ≡ `1000` | 分组分隔符，不携带信息 | **开** |
 * | `1，000`（全角） | 同上，NFKC 后归一 | **开** |
 * | `1_000` | 编程惯例 | 关（`_` 多为标识符一部分） |
 * | `一千` ≡ `1000` | **另一套数词系统** | 关 |
 *
 * 前三者的共同点：数值不变，只是书写习惯不同，属于「折叠」。
 * 中文数词是**换了一套系统**，且存在语义歧义，见 {@link parseChineseNumeral}。
 *
 * ## 调用时机：必须在 NFKC 之后、标点折叠之前
 *
 * 千分位 `1,000` 里的 `,` 是排版符；顿号 `1、000` 里的 `、` 是列表分隔符。
 * 等到标点折叠之后，两者都变成 `,`，**无从区分**。
 * 但它也不能早于 NFKC —— 中文文档里千分位多是全角 `1，000`。
 *
 * @packageDocumentation
 */

/**
 * 千分位分组：**正好 3 位**且后面不再跟数字。
 * `(?!\d)` 是关键 —— 否则 `1,0000`（四位）也会被误当成千分位。
 *
 * @remarks
 * 分隔符字符集由 {@link buildGroupedDigitsPattern} 按「NFKC 等价于 `,`」动态生成，
 * 因此全角 `1，000` 也能匹配；顿号 `、` 不满足，故被排除。
 */
export const GROUPED_DIGITS_PATTERN = /(\d)((?:[,，\uFE50]|_)(\d{3}))+(?!\d)/g;

/**
 * 按给定分隔符集合构造分组正则。
 *
 * @remarks
 * 默认正则已覆盖常见逗号族；若调用方要支持别的分隔符（或刻意排除全角），
 * 用它构造。返回值**每次都是新的对象** —— 正则带 `g` 标志且有 `lastIndex` 状态，
 * 共享会引发难以定位的 bug。
 */
export function buildGroupedDigitsPattern(separators: ReadonlySet<string>): RegExp {
  const chars = [...separators].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('');
  if (chars.length === 0) return /(?!)/g; // 永不匹配
  return new RegExp('(\\d)((?:[' + chars + '])(\\d{3}))+(?!\\d)', 'g');
}

/**
 * 去掉数字分组分隔符：`1,000` → `1000`。
 *
 * @param text 已过 NFKC 的文本
 * @param separators 视为分组符的字符集合，默认 `{ ',' }`
 * @returns 去掉分组符后的文本
 *
 * @example
 * ```ts
 * stripGroupingSeparators('共1,000人');            // '共1000人'
 * stripGroupingSeparators('共1,000人', new Set()); // '共1,000人'
 * ```
 */
export function stripGroupingSeparators(text: string, separators: ReadonlySet<string> = new Set([','])): string {
  if (separators.size === 0) return text;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (/[0-9]/.test(text[i])) {
      GROUPED_DIGITS_PATTERN.lastIndex = i;
      const m = GROUPED_DIGITS_PATTERN.exec(text);
      if (m && m.index === i) {
        for (const c of m[0]) if (!separators.has(c)) out += c;
        i += m[0].length;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/**
 * 中文数词解析 —— **本库不自己实现，交由专门的库**。
 *
 * @remarks
 * 这个模块曾经自己写了 177 行解析器，实测下来是个错误：
 *
 * | 输入 | 自研实现 | `cjk-number` |
 * |---|---|---|
 * | `两万` | ❌ | ✅ 20000 |
 * | `二〇二三` | ✅ 2023 | ✅ 2023 |
 * | `負一百零二` | ❌ | ✅ -102 |
 * | `一點二三` | ❌ | ✅ 1.23 |
 * | `一万二千三百四十五` | ❌ | ✅ 12345 |
 * | `三思而行` | `3思而行` | `3思而行`（**同样无法避免**） |
 *
 * ## 诚实说明：什么被解决了，什么没有
 *
 * 换库解决的是**纯数词解析的正确性**（口语「两」、年份、负数、小数、连续进位）。
 *
 * 但**「某个汉字在此处是否为数词」这个歧义依然存在**。
 * 整串调用 `number.parse('三思而行')` 确实会抛错，看似提供了"不是数词"的信号；
 * 然而适配层为了拿到 `consumed` 必须**分段尝试**，于是「三」又被单独解析成 3。
 * 最终结果和自研实现一样是 `3思而行`。
 *
 * 这是**语言本身的固有歧义**，不是实现缺陷 —— 所以 `cjkNumerals` 默认关闭。
 * 详细讨论见 README 的「多义词」章节。
 */

/** 解析结果 */
export interface ParsedChineseNumeral {
  /**
   * 数值，以**字符串**形式给出。
   *
   * @remarks
   * 不用 `number`：超大数会超出安全整数范围，`cjk-number` 也会返回 `bigint`。
   * 归一化的产物本来就是字符串，用字符串可完全避免精度问题。
   */
  value: string;
  /**
   * 消耗的字符数。
   *
   * @remarks
   * **这是外部库不提供、必须由适配层补齐的信息**。
   * 归一化要用它来维护 `map` / `mapEnd` —— 中文数词长度可变
   * （`一千` → `1000` 是 2 字符变 4 字符），不知道消耗长度就无法映射坐标。
   */
  consumed: number;
}

/** 中文数词解析后端 */
export interface ChineseNumeralParser {
  /** 名称，用于调试与 `via` 字段 */
  readonly name: string;
  /**
   * 从 `at` 处解析一个中文数词。
   * @returns 解析结果；`null` 表示这里不是数词
   */
  parse(text: string, at: number): ParsedChineseNumeral | null;
}

/**
 * 可能出现在中文数词里的字符。
 *
 * @remarks
 * 仅用于**快速预筛**：归一化会对每个位置调用解析，若不在该集合中直接返回 `null`，
 * 避免对每个汉字都去调外部库（实测 `cjk-number` 单次约 7μs，全文逐位置调用会明显变慢）。
 */
export const CHINESE_NUMERAL_CHARS: ReadonlySet<string> = new Set([
  // 小写数字
  '零', '〇', '一', '二', '两', '三', '四', '五', '六', '七', '八', '九',
  // 大写数字
  '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖',
  // 单位
  '十', '百', '千', '拾', '佰', '仟', '万', '亿', '兆', '萬', '億',
  // 小数 / 负数
  '点', '點', '负', '負',
]);

/** `cjk-number` 的最小接口（只取用到的部分，避免强依赖类型） */
export interface CjkNumberLike {
  number: {
    parse(input: string, options?: { strict?: boolean }): number | bigint;
  };
}

export interface CjkNumeralParserOptions {
  /** 单个数词最多按多少字匹配，防御性地设上界 */
  maxLength?: number;
  /** 传给 `cjk-number` 的 `strict` 选项 */
  strict?: boolean;
}

/**
 * 用 `cjk-number` 实现中文数词解析。
 *
 * @remarks
 * **为什么选它**（实测纯数词 16/16，对比见文件头表格）：
 * - 覆盖小写 / 大写 / 口语（`两`）/ 年份（`二〇二三`）/ 负数 / 小数 / 连续进位
 * - ESM、TypeScript、Node 18+，活跃维护
 *
 * @remarks
 * **它是 ESM-only**（`package.json` 没有 CJS main，`require` 会失败）。
 * 因此只能作为**可选 peer 依赖**注入 —— 本库的 CJS 产物无法引用它。
 *
 * `consumed` 由适配层补齐：取从 `at` 开始的最长数字串，**从长到短**尝试，
 * 第一个解析成功的即为最长匹配。
 *
 * 注意这个分段尝试有个副作用：整串输入时库会拒绝的内容（`三思而行`），
 * 分段后仍会被解析出「三」。这是固有歧义，见文件头说明。
 *
 * @example
 * ```ts
 * import * as cjk from 'cjk-number';
 * locateExcerpt(ex, text, {
 *   cjkNumerals: true,
 *   cjkNumeralParser: createCjkNumberParser(cjk),
 * });
 * ```
 */
export function createCjkNumberParser(
  cjk: CjkNumberLike,
  options: CjkNumeralParserOptions = {}
): ChineseNumeralParser {
  const maxLength = options.maxLength ?? 16;
  return {
    name: 'cjk-number',
    parse(text: string, at: number): ParsedChineseNumeral | null {
      if (at >= text.length || !CHINESE_NUMERAL_CHARS.has(text[at])) return null;
      // 向后取最长的连续数词字符
      let end = at;
      while (end < text.length && CHINESE_NUMERAL_CHARS.has(text[end])) end += 1;
      const limit = Math.min(end, at + maxLength);
      // 从长到短尝试：第一个成功的就是最长匹配
      for (let e = limit; e > at; e -= 1) {
        let raw: number | bigint;
        try {
          raw = cjk.number.parse(text.slice(at, e), options.strict ? { strict: true } : undefined);
        } catch {
          continue; // 不是完整数词 → 试更短
        }
        const value = typeof raw === 'bigint' ? raw.toString() : String(raw);
        if (!value || value === 'NaN' || value === 'undefined') continue;
        return { value, consumed: e - at };
      }
      return null;
    },
  };
}
