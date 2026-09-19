/**
 * `ignorePunctuation` 的精细化控制。
 *
 * ## 为什么不是一个 boolean
 *
 * 「忽略标点」其实是**三件事**，代价各不同，不该共用一个开关：
 *
 * | 子决策 | 取值 | 默认 |
 * |---|---|---|
 * | 哪些字符算标点 | `\p{P}`、追加 `\p{S}`、追加自定义字符 | `\p{P}` |
 * | 折叠后是否保留占位符 | `fold`（按文字角色裁决）/ `drop`（一律删） | `fold` |
 * | 有没有例外 | `keep` 保护区 | 空；上层可注入 |
 *
 * 压成一个布尔位的后果在真实用例里暴露得很清楚：
 *
 * ```
 * ignorePunctuation: true 时，摘录里的省略号「……」被折成占位符又被删掉
 * → T2 分段锚点找不到切分点 → 开了「忽略标点」反而连「 Federated 」式引用也废了
 * ```
 *
 * 省略表达是**结构**而不是排版 —— 它是用户或系统明确写下的分隔符，
 * 默认不该被折叠。要折，得开关明确要求（`preserveEllipsis: false`）。
 */

/** 折叠后的处置方式 */
export type IgnorePunctuationMode =
  /** 折成占位符，是否删除交给文字的「空格角色」裁决（现状，也是最安全的） */
  'fold' |
  /** 占位符一律删除：连拉丁词边界的空格一起丢，只留文字骨架 —— 查重场景用 */
  'drop';


/** 保护区的一段：字符串按字面量，正则按原样（对省略号之类必须给正则） */
export type IgnorePunctuationKeep = string | RegExp;

export interface IgnorePunctuationOptions {
  /** 处置方式，见 {@link IgnorePunctuationMode}。@defaultValue `'fold'` */
  mode?: IgnorePunctuationMode;
  /**
   * 是否把 Unicode 符号类 `\p{S}` 也算标点。
   *
   * @remarks
   * 反引号 `` ` `` 是 `Sk`（修饰符号）、`+ = ~ |` 是 `Sm` —— 都不在 `\p{P}` 里，
   * 所以在代码 / 数学文本里它们载义，默认**不**参与折叠。
   * @defaultValue `false`
   */
  symbols?: boolean;
  /**
   * 追加自定义的标点字符。
   *
   * @remarks
   * 用于那些「在当前语料里明确不载义」的字符：例如某些爬虫残留的 `*`、`|`。
   * 与 `symbols` 的差别：那是打开一整类 Unicode，这是点名几个字符。
   */
  extra?: readonly string[];
  /**
   * 保护区：命中的片段**原样保留**，不参与折叠。
   *
   * @remarks
   * 给「连 drop 也要留下某些东西」留的口子：例如 `keep: [/\s+/]` 表示
   * 只折叠标点、保留词边界（此时 `drop` 退化为「只删标点」而非「删光分隔符」）。
   */
  keep?: readonly IgnorePunctuationKeep[];
  /**
   * 是否保护「上层知道的系统 / 用户省略表达」（由调用方注入 `keep`，如摘录的 `……`）。
   *
   * @remarks
   * 默认是保护的 —— 省略表达的结构性优先于「忽略标点」。
   * 确要一并折叠（比如摘录里已经不可能出现省略号）才显式置 `false`。
   * @defaultValue `true`
   */
  preserveEllipsis?: boolean;
}

export type IgnorePunctuationOption = boolean | IgnorePunctuationMode | IgnorePunctuationOptions;

/** 归一化后的内部形态 —— `boolean` / `'drop'` / 对象三种写法在这里收敛成一种 */
export interface ResolvedIgnorePunctuation {
  enabled: boolean;
  mode: IgnorePunctuationMode;
  /** 判定「算作标点」的字符类；未启用时为 `null` */
  pattern: RegExp | null;
  /** 保护区模式；无需保护时为 `null` */
  keep: RegExp | null;
  preserveEllipsis: boolean;
}

/** Unicode 标点类 —— 「哪些字符算标点」的默认答案 */
const PUNCT_CLASS = '\\p{P}';

const DISABLED: ResolvedIgnorePunctuation = {
  enabled: false,
  mode: 'fold',
  pattern: null,
  keep: null,
  preserveEllipsis: true,
};

function escapeCharClass(s: string): string {
  // 字符类内部只需转义 ] \ ^ - 四个
  return s.replace(/[\\\]^-]/g, '\\$&');
}

function buildPunctPattern(symbols?: boolean, extra?: readonly string[]): RegExp {
  let cls = PUNCT_CLASS;
  if (symbols) cls += '\\p{S}';
  if (extra && extra.length > 0) cls += escapeCharClass(extra.join(''));
  return new RegExp(`[${cls}]`, 'u');
}

function escapeLiteral(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把保护区的若干模式并成一个带 g 的正则 —— 需要 `lastIndex` 推进，不带 g 会死循环。
 *
 * @remarks
 * **字符串先过 NFKC**，与省略号模式的既有约定一致（见上层 `ellipsis`）：
 * 判定发生在流水线第 4 阶段，此时 NFKC 已经把 `……` 折成 `......`，
 * 照字面去匹配「用户书写形态」的字符串必然落空。
 * 正则则按原样使用 —— 调用方写正则时本来就该假定它作用在归一化后的文本上。
 */
function buildKeepPattern(keep: readonly IgnorePunctuationKeep[] | undefined): RegExp | null {
  if (!keep || keep.length === 0) return null;
  const parts = keep
    .map((p) => {
      if (p instanceof RegExp) return p.source.length > 0 ? `(?:${p.source})` : null;
      const s = p.normalize('NFKC');
      return s.length > 0 ? `(?:${escapeLiteral(s)})` : null;
    })
    .filter((x): x is string => x !== null);
  if (parts.length === 0) return null;
  return new RegExp(parts.join('|'), 'gu');
}

/**
 * 标出保护区覆盖到的下标 —— 这些位置上的字符原样通过，不折叠。
 *
 * @remarks
 * 用 `Uint8Array` 而不是 Set：这里是热路径上的逐下标查表，O(1) 且不装箱。
 */
export function markKeepRanges(text: string, keep: RegExp | null): Uint8Array | null {
  if (!keep) return null;
  const flags = new Uint8Array(text.length + 1);
  const re = new RegExp(keep.source, keep.flags);
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++; // 零宽匹配会原地打转
      continue;
    }
    for (let p = m.index; p < m.index + m[0].length; p++) flags[p] = 1;
  }
  return flags;
}

/**
 * 把 `boolean | 'fold' | 'drop' | 对象` 收敛成 {@link ResolvedIgnorePunctuation}。
 *
 * @remarks
 * 这是本模块唯一的对外契约：调用方（含上层 `locator`）不必记住四种写法的优先级，
 * 一律先过这个函数，之后只看 `enabled / mode / pattern / keep`。
 *
 * @example
 * ```ts
 * normalizeIgnorePunctuationOption(true);                       // fold + \p{P}
 * normalizeIgnorePunctuationOption('drop');                     // 连词边界一起删
 * normalizeIgnorePunctuationOption({ symbols: true });          // 反引号也算标点
 * normalizeIgnorePunctuationOption({ keep: [/\s+/] });          // 只折标点，保留词边界
 * ```
 */
export function normalizeIgnorePunctuationOption(
  input: IgnorePunctuationOption | undefined
): ResolvedIgnorePunctuation {
  if (!input) return DISABLED;
  if (input === true) return { enabled: true, mode: 'fold', pattern: buildPunctPattern(), keep: null, preserveEllipsis: true };
  if (input === 'fold' || input === 'drop') {
    return { enabled: true, mode: input, pattern: buildPunctPattern(), keep: null, preserveEllipsis: true };
  }
  if (typeof input !== 'object') return DISABLED;

  return {
    enabled: true,
    mode: input.mode ?? 'fold',
    pattern: buildPunctPattern(input.symbols, input.extra),
    keep: buildKeepPattern(input.keep),
    preserveEllipsis: input.preserveEllipsis ?? true,
  };
}

/**
 * 把新的 `keep` 追加到一个已析出的配置上。
 *
 * @remarks
 * 上层（`excerpt-match`）知道哪些是「用户 / 系统定义的省略表达」，
 * 需要在最后把它们并入保护区 —— 它是协作者，**知情者补充，而不是覆盖**。
 */
export function withKeep(
  input: IgnorePunctuationOption | undefined,
  keep: readonly IgnorePunctuationKeep[]
): IgnorePunctuationOption {
  if (keep.length === 0) return input ?? false;
  const resolved = normalizeIgnorePunctuationOption(input);
  if (!resolved.enabled || !resolved.preserveEllipsis) return input ?? false;
  const base: IgnorePunctuationOptions =
    typeof input === 'object' && input !== null ? { ...input } : {};
  if (input === 'fold' || input === 'drop') base.mode = input;
  base.keep = [...(base.keep ?? []), ...keep];
  return base;
}
