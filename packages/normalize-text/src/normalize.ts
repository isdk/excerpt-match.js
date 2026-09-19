/**
 * 归一化 —— 全库唯一有"魔法"的地方，也是唯一必须自己写的部分。
 *
 * 为什么不能用现成库：没有任何库提供「归一化 + 原文下标映射」。
 * 而只要做归一化，就必然改变长度，没有映射就拿不回 index。
 *
 * 设计不变量（test.mjs 有属性测试覆盖）：
 *   1. 幂等：normalize(normalize(x)) === normalize(x)
 *   2. 单调：map[i] <= map[i+1]
 *   3. 可回切：page.slice(map[i], map[j]) 归一化后 === text.slice(i, j)
 */

import type { NormalizedText } from './types';
import type { ParticleTagger } from '@isdk/zh-particles';
import { createGuardListParticleTagger } from '@isdk/zh-particles';
// 同包内一律用相对路径 —— 通过自己的包名 import 会绕公开入口一圈，
// 既让打包器的循环分析变复杂，也可能在发布后（exports 指向 dist）出问题
import { GROUPED_DIGITS_PATTERN } from './numberNotation';
import type { ChineseNumeralParser } from './numberNotation';
import { canDropSpaceBetween, unicodeScriptOf } from '@isdk/whitespace-semantics';
import { findIdentifierBreaks, type IdentifierBreak } from '@isdk/identifier-variants';
import { markKeepRanges, normalizeIgnorePunctuationOption } from './ignorePunctuation';
import type { IgnorePunctuationOption } from './ignorePunctuation';
export { snapToGraphemeBoundary } from './grapheme';

/** 空白 / 被忽略标点的统一占位符。注意：正文若真含 U+0001 需先剔除 */
const FOLDED_PLACEHOLDER = '\u0001';

// 标点怎么算、折后要不要留占位符、有无例外 —— 见 ./ignorePunctuation 的三种写法
// （`\p{P}` 这个默认答案由 `normalizeIgnorePunctuationOption` 给出）

const ZERO_WIDTH_CODE_POINTS = new Set<number>([
  0x00ad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f,
  0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0x061c,
]);

function isZeroWidthCodePoint(cp: number): boolean {
  return ZERO_WIDTH_CODE_POINTS.has(cp) || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0100 && cp <= 0xe01ef);
}

const WHITESPACE_PATTERN = /\s/u;

/**
 * 标点折叠表：组内归一到第一个字符。
 * 注意是「多对一折叠」而不是「替换表」——替换表永远补不全，且容易破坏幂等性。
 */
const PUNCTUATION_FOLD_GROUPS: string[][] = [
  [',', '，', '、', '﹐'],
  ['.', '。', '．', '｡'],
  [';', '；'], [':', '：'],
  ['?', '？', '﹖'], ['!', '！', '﹗'],
  ['(', '（', '﹙'], [')', '）', '﹚'],
  ['[', '【', '〔', '［'], [']', '】', '〕', '］'],
  ['"', '“', '”', '「', '」', '『', '』', '＂'],
  ["'", '‘', '’', '＇', '´'],
  ['-', '—', '–', '−', '﹣', '－'],
  ['…', '⋯'], ['<', '《', '〈'], ['>', '》', '〉'],
];

const PUNCTUATION_FOLD_MAP = new Map<string, string>();
for (const g of PUNCTUATION_FOLD_GROUPS) {
  for (const c of g) if (!PUNCTUATION_FOLD_MAP.has(c)) PUNCTUATION_FOLD_MAP.set(c, g[0]);
}

/**
 * 中文结构助词等价类：的 / 地 / 得。
 *
 * 这三个字作**助词**时混用极其普遍，属于同音替换而非语义改写。
 * 但作**实词**时（大地 / 土地 / 得到 / 值得 / 地址）绝不能折叠 ——
 * `大地` 与 `大的` 是两个不同的词。
 *
 * 所以是否能折叠取决于**词性**，必须由 {@link ParticleTagger} 判定，
 * 不能无脑折叠。折叠到组内第一个字符「的」而非哨兵字符，
 * 是为了保留 CJK 属性：`dropSpaceBetweenCJK` 依赖它判断相邻字符是不是中文。
 *
 * @remarks
 * 实测教训：无脑折叠会让「辽阔的大地」匹配上「辽阔的大的」，
 * 且 `score = 1.00`（宣称完全一致）。在引用校验场景下这是致命的。
 */
const CHINESE_PARTICLE_GROUPS: string[][] = [
  ['的', '地', '得'],
];

const CHINESE_PARTICLE_FOLD_MAP = new Map<string, string>();
for (const g of CHINESE_PARTICLE_GROUPS) {
  for (const c of g) if (!CHINESE_PARTICLE_FOLD_MAP.has(c)) CHINESE_PARTICLE_FOLD_MAP.set(c, g[0]);
}

let sharedTagger: ParticleTagger | null = null;
/** 内置判定器是纯函数，全局共享一个实例即可 */
function sharedGuardListTagger(): ParticleTagger {
  return (sharedTagger ??= createGuardListParticleTagger());
}
const nfkcFoldCache = new Map<number, string>();
function foldCodePointWithNfkc(cp: number): string {
  let v = nfkcFoldCache.get(cp);
  if (v === undefined) {
    v = String.fromCodePoint(cp).normalize('NFKC'); // 全角→半角、ﬁ→fi、①→1
    nfkcFoldCache.set(cp, v);
  }
  return v;
}

/** {@link normalizeWithMap} 的选项 */
export interface NormalizeOptions {
  /** 是否忽略大小写。用 `toLowerCase` 而非 `toUpperCase` —— `ß.toUpperCase()` 会变成 `SS`，改变长度、破坏映射 */
  ignoreCase?: boolean;
  /**
   * 是否忽略标点。中文标点常载义，默认关闭。
   *
   * @remarks
   * 除了 `boolean`，还支持两种更细的写法 —— 「哪些字符算标点」「折后留不留占位符」
   * 「有没有例外」其实是三件事，见 {@link IgnorePunctuationOption}：
   *
   * ```ts
   * { ignorePunctuation: true }                        // 折成占位符，删不删看两侧文字
   * { ignorePunctuation: 'drop' }                      // 占位符一律删：只留文字骨架
   * { ignorePunctuation: { symbols: true } }           // 反引号、+ = ~ 这类符号也算标点
   * { ignorePunctuation: { keep: [/\s+/] } }           // 只折标点，词边界照旧
   * ```
   */
  ignorePunctuation?: IgnorePunctuationOption;
  /** 是否做 NFKC 折叠：全角→半角、`ﬁ`→`fi`、`①`→`1` */
  ignoreWidth?: boolean;
  /** CJK 相邻时删除其间的空白占位符：<p>你好</p><p>世界</p> ≡ 复制出的「你好 世界」 */
  /** CJK 相邻时是否删除其间的空白：`<p>你好</p><p>世界</p>` 与复制出的「你好 世界」等价。英文不受影响 */
  dropSpaceBetweenCJK?: boolean;
  /**
   * 中文结构助词「的 / 地 / 得」的折叠策略。
   *
   * - `false`（默认）—— 完全不折叠。**最安全**，零误判。
   * - `true` —— 内置保守模式：实词保护表。零依赖，但保护表补不全。
   * - {@link ParticleTagger} —— 精确判定。推荐
   *   {@link createJiebaParticleTagger}（`@isdk/nlp-jieba`，词典驱动）。
   *
   * @remarks
   * **为什么默认 false**：无脑折叠会让「辽阔的大地」匹配上「辽阔的大的」
   * 且 `score = 1.00`。误判代价高于漏判 —— 漏了只是少个命中，
   * 错了是造了个假引用。
   *
   * 折叠是 1→1 的，不改变长度，坐标映射不受影响。
   * @defaultValue `false`
   */
  ignoreParticles?: boolean | ParticleTagger;

  /**
   * 是否归一数字分组分隔符：`1,000` ≡ `1000`。
   *
   * @remarks
   * 只认「分隔符后正好 3 位且不再跟数字」的严格模式，
   * 因此 `1,0000`、`12,34` 不会被误处理。
   *
   * 在 **NFKC 之后、标点折叠之前**执行，所以全角 `1，000` 也能识别，
   * 而顿号 `1、000` 不会（顿号不被 NFKC 折叠，仍是列表分隔符）。
   * 详见 {@link normalizeWithMap}。
   * @defaultValue `true`
   */
  numberGrouping?: boolean;

  /**
   * 是否也把 `_` 当作数字分组分隔符（`1_000` ≡ `1000`）。
   *
   * @remarks
   * 默认关闭：`_` 更常见的身份是标识符的一部分（`MAX_SIZE`、`foo_bar`），
   * 虽然正则要求「数字_三位数字」已相当严格，但仍按保守处理。
   * @defaultValue `false`
   */
  groupingUnderscore?: boolean;

  /**
   * 是否把中文数词转成阿拉伯数字（`一千` ≡ `1000`）。
   *
   * @remarks
   * **默认关闭**，因为这是「换了一套数词系统」而非「同一种表示法」：
   * - 语义歧义：`三思而行`、`三人成虎` 里的「三」不是数词
   * - 上下文依赖：`第1000条` 该转，`三思` 不该转，需要上下文判断
   *
   * 支持 `一千` / `十五` / `一百二十三` / `两万` / `二〇二三` / `壹仟` 等常见形式。
   * @defaultValue `false`
   */
  cjkNumerals?: boolean;

  /**
   * 中文数词的解析后端。**开启 `cjkNumerals` 时必需**。
   *
   * @remarks
   * 本库不自己实现中文数词解析 —— `cjk-number` 等专门库做得更好
   * （支持口语「两」、年份「二〇二三」、负数、小数，且非数词会抛错）。
   * 请注入 {@link createCjkNumberParser} 构造的后端。
   */
  cjkNumeralParser?: ChineseNumeralParser;

  /**
   * 是否把驼峰标识符拆成带空格的形式：`HelloWorld` → `Hello World`。
   *
   * @remarks
   * 方向刻意选**拆分**而非合并 —— 自然文本里不会出现两个词紧贴无空格，
   * 所以「无空格 + 驼峰」是标识符的强信号；反之据「有空格 + 驼峰」删空格
   * 会误伤 `Hello World` 这类普通词组。
   *
   * 已知限制：`McDonald` → `Mc Donald`、`iPhone` → `i Phone` 会误拆。
   * @defaultValue `false`
   */
  splitCamelCase?: boolean;

  /**
   * 是否把标识符里的 `_` / `-` 视为空格：`hello_world` ≡ `hello-world` ≡ `hello world`。
   *
   * @remarks
   * 只在两侧都是 `[A-Za-z0-9]` 时生效，
   * 所以 `北京-上海` 不会被拆（那会把两个地名并成一个）。
   * @defaultValue `false`
   */
  normalizeIdentifierSeparators?: boolean;
}

/**
 * 归一化文本，同时保留「归一化下标 → 原文下标」的映射。
 *
 * 这是全库唯一必须自己实现的部分：没有任何现成库提供
 * 「归一化后还能回切原文坐标」的能力。
 *
 * ## 分阶段流水线（**顺序是设计的一部分**）
 *
 * ```
 * 1. foldWidth        NFKC 折叠 + 剔除零宽字符
 * 2. normalizeNumbers 数字记法归一        ← 必须在标点折叠之前，见下
 * 3. foldCase         大小写
 * 4. foldPunctAndSpace 标点折叠 / 助词折叠 / 空白 → 占位符 / 跨文字删空格
 * ```
 *
 * **为什么数字归一必须排在标点折叠之前**（关键）：
 *
 * 千分位 `1,000` 里的 `,` 是纯排版符，应被删掉；但顿号 `1、000` 里的 `、`
 * 是列表分隔符，不能删。若等到第 4 步，两者都已被折成 `,`，无从区分。
 *
 * 而它也**不能排在 NFKC 之前** —— 中文文档里千分位多是全角 `1，000`，
 * 只有 NFKC 之后才变成 `,`。所以精确位置是：**在 NFKC 之后、标点折叠之前**。
 *
 * ```
 * 1,000  (半角)  NFKC → 1,000   → 命中千分位  ✅
 * 1，000 (全角)  NFKC → 1,000   → 命中千分位  ✅  ← 中文文档主流写法
 * 1、000 (顿号)  NFKC → 1、000  → 不命中      ✅
 * ```
 *
 * 这是「折叠」而非「替换表」思路的延续：靠前置的通用折叠把变体收敛，
 * 后续规则只需认一种形式，不必穷举（穷举永远补不全）。
 *
 * **设计不变量**（由属性测试覆盖）：
 * 1. 幂等：`normalize(normalize(x)) === normalize(x)`
 * 2. 单调：`map` 单调不减
 * 3. 可回切：`src.slice(map[i], mapEnd[i])` 归一化后 === `text[i]`
 *
 * @param src 原文字符串，或已带映射的中间结果（链式处理时用后者）
 * @param options 归一化选项
 * @returns 归一化文本 + 下标映射，见 {@link NormalizedText}
 *
 * @example 链式：md 摊平 → 归一化，映射复合后仍指向 md 源码
 * ```ts
 * const flat = md.flatten(mdSource);
 * const hay = normalizeWithMap(flat, { ignoreCase: true });
 * mdSource.slice(hay.map[0], hay.mapEnd![0]); // → md 源码片段
 * ```
 */
export function normalizeWithMap(src: string | NormalizedText, options: NormalizeOptions = {}): NormalizedText {
  let current: NormalizedText = typeof src === 'string' ? createIdentityMap(src) : src;
  current = foldWidth(current, options);
  current = normalizeNumberNotation(current, options);
  current = normalizeIdentifierSpelling(current, options);
  current = foldCase(current, options);
  current = foldPunctuationAndSpace(current, options);
  return current;
}

// #region 阶段 1：宽度折叠

/**
 * NFKC 折叠 + 剔除零宽字符。
 *
 * 必须最先执行：它把全角标点收敛成半角，后续所有规则只需认半角一种形式 ——
 * 这是「折叠」思路的核心，避免为每种变体写一条规则（穷举永远补不全）。
 */
function foldWidth(input: NormalizedText, options: NormalizeOptions): NormalizedText {
  if (options.ignoreWidth === false) return input;
  const base = input.text;
  const baseMap = input.map;
  const baseEnd = input.mapEnd ?? inferCharEndOffsets(baseMap, base);
  const out: string[] = [];
  const map: number[] = [];
  const mapEnd: number[] = [];
  const back: number[] = [];
  // back 必须**跨阶段复合**：本阶段输入下标 at → 更上层输入下标。
  // 若只写 at，最终 back 只反映最后一个阶段，前面的长度变化就丢了。
  const backOf = (at: number): number => {
    const b = input.back;
    if (!b || b.length === 0) return at;
    return b[Math.max(0, Math.min(at, b.length - 1))] ?? at;
  };
  let changed = false;
  let i = 0;
  while (i < base.length) {
    const cp = base.codePointAt(i) as number;
    const w = cp > 0xffff ? 2 : 1;
    if (isZeroWidthCodePoint(cp)) {
      changed = true;
      i += w;
      continue;
    }
    const folded = foldCodePointWithNfkc(cp);
    const k = Math.min(i, baseMap.length - 1);
    // 源码侧：整个字符（含低代理项）的结束位置 —— 不能用 baseEnd[k]，
    // 那会落在代理对中间，切出半个代理项
    const srcEnd = charEndOffset(baseEnd, i, w);
    // ★ 按 **code unit** 展开（不是 `for...of` 的 code point）。
    //   归一化下标的口径必须与 `String.prototype.indexOf` / `slice` 一致，
    //   否则 `map.length !== text.length + 1`，下游取 `map[at]` 会拿到 undefined。
    for (let u = 0; u < folded.length; u++) {
      out.push(folded[u]);
      map.push(baseMap[k]);
      mapEnd.push(srcEnd);
      back.push(backOf(i));
    }
    if (folded !== base.slice(i, i + w)) changed = true;
    i += w;
  }
  if (!changed) return input;
  return appendTerminator(out.join(''), map, mapEnd, base.length, back);
}

// #endregion

// #region 阶段 2：数字记法归一

/**
 * **NFKC 等价于 `,`** 的字符：`,` `，` `﹐` …
 *
 * 注意**不含顿号 `、`** —— 顿号是列表分隔符，不被 NFKC 折叠，
 * 所以 `1、000` 不会被当成千分位。这是刻意的区分，见 {@link normalizeWithMap}。
 *
 * @remarks
 * **为什么按 NFKC 等价而不是写死 `new Set([','])`**：
 * 若 `ignoreWidth: false`，NFKC 不执行，全角 `1，000` 到阶段 2 时还带着 `，`
 * —— 只认半角逗号就匹配不上，等阶段 4 折成 `,` 后，**再归一化一次才匹配**。
 * 实测的不幂等：`共1，000人` → `共1,000人` → `共1000人`。
 *
 * 按「NFKC 是否等于 `,`」判定，可让分组规则与 NFKC 解耦，
 * 从而在任何选项组合下都幂等，同时保留顿号的区分。
 */
let commaLikeCache: Set<string> | null = null;
function commaLikeCharacters(): Set<string> {
  if (commaLikeCache) return new Set(commaLikeCache);
  const group = PUNCTUATION_FOLD_GROUPS.find((g) => g.includes(',')) ?? [','];
  const set = new Set<string>();
  for (const c of group) {
    // 只收 NFKC 后真的变成 ',' 的 —— 顿号不满足，因此被排除
    if (c === ',' || c.normalize('NFKC') === ',') set.add(c);
  }
  commaLikeCache = set;
  return new Set(set);
}

/**
 * 数字记法归一：`1,000` ≡ `1000`，可选 `一千` ≡ `1000`。
 *
 * **必须排在 NFKC 之后、标点折叠之前** —— 理由见 {@link normalizeWithMap}。
 * 规则细节与已知限制见 `numberNotation.ts`。
 */
function normalizeNumberNotation(input: NormalizedText, options: NormalizeOptions): NormalizedText {
  const stripGrouping = options.numberGrouping ?? true;
  const expandChinese = options.cjkNumerals ?? false;
  const numeralParser = options.cjkNumeralParser;
  if (!stripGrouping && !expandChinese) return input;

  // 关键：分隔符取「NFKC 等价于 , 的整族」，而非只有半角 ','
  // 这样分组判定与 NFKC 解耦，任何选项组合下都幂等；顿号不满足故被排除
  const separators = commaLikeCharacters();
  if (options.groupingUnderscore ?? false) separators.add('_');

  const base = input.text;
  const baseMap = input.map;
  const baseEnd = input.mapEnd ?? inferCharEndOffsets(baseMap, base);
  const out: string[] = [];
  const map: number[] = [];
  const mapEnd: number[] = [];
  const back: number[] = [];
  const backOf = (at: number): number => {
    const b = input.back;
    if (!b || b.length === 0) return at;
    return b[Math.max(0, Math.min(at, b.length - 1))] ?? at;
  };
  let changed = false;
  let i = 0;

  const copyChar = (at: number): void => {
    const k = Math.min(at, baseMap.length - 1);
    out.push(base[at]);
    map.push(baseMap[k]);
    mapEnd.push(baseEnd[k]);
    back.push(backOf(at));
  };
  const writeChar = (ch: string, at: number): void => {
    const k = Math.min(at, baseMap.length - 1);
    out.push(ch);
    map.push(baseMap[k]);
    mapEnd.push(baseEnd[k]);
    back.push(backOf(at));
  };

  while (i < base.length) {
    if (expandChinese && numeralParser) {
      const parsed = numeralParser.parse(base, i);
      if (parsed) {
        const digits = String(parsed.value);
        for (let k = 0; k < digits.length; k++) writeChar(digits[k], i);
        // 末位补上完整 span，保证 length 覆盖整个中文数词
        mapEnd[mapEnd.length - 1] = baseEnd[Math.min(i + parsed.consumed - 1, baseEnd.length - 1)];
        changed = true;
        i += parsed.consumed;
        continue;
      }
    }
    if (stripGrouping && base[i] >= '0' && base[i] <= '9') {
      GROUPED_DIGITS_PATTERN.lastIndex = i;
      const m = GROUPED_DIGITS_PATTERN.exec(base);
      if (m && m.index === i && separators.has(m[0][1] ?? '')) {
        for (let k = 0; k < m[0].length; k++) if (!separators.has(m[0][k])) copyChar(i + k);
        changed = true;
        i += m[0].length;
        continue;
      }
    }
    copyChar(i);
    i += 1;
  }
  if (!changed) return input;
  return appendTerminator(out.join(''), map, mapEnd, base.length, back);
}

// #endregion

// #region 阶段 2b：标识符拼写归一


/**
 * 标识符拼写归一：把 `HelloWorld` / `hello_world` / `hello-world` 都收敛成 `hello world`。
 *
 * **方向是刻意选的：拆分（插空格），而不是合并（删空格）。**
 *
 * 两个方向看似对称，安全性却完全不同：
 *
 * ```
 * 合并 Hello World → HelloWorld   普通的两个单词也被并掉了  ❌
 * 拆分 HelloWorld  → Hello World  只在「本该有空格却没有」处插入  ✅
 * ```
 *
 * 关键不对称：**自然文本里不会出现两个词紧贴无空格**（`thecourt` 不是合法英文），
 * 所以「无空格 + 驼峰」是标识符的强信号；而「有空格 + 驼峰」在标题、人名里到处都是
 * （`Hello World`），据此删空格必然误伤。
 *
 * 同理，`thecourt` 因为小写接小写、没有驼峰，拆分规则根本不会触发。
 *
 * @remarks
 * 只在**标识符语境**（两侧都是 `[A-Za-z0-9]`）内生效，
 * 所以 `北京-上海` 不会被拆成 `北京上海`（那才是危险的合并方向）。
 *
 * 已知限制：`McDonald` → `Mc Donald`、`iPhone` → `i Phone` 会误拆。
 * 但由于页面与摘录走同一套转换，只有两个**不同**的原文收敛成同一串时才会误判。
 *
 * 必须排在 `foldCase` 之前 —— 驼峰判定依赖原始大小写。
 */
function normalizeIdentifierSpelling(input: NormalizedText, options: NormalizeOptions): NormalizedText {
  const splitCamel = options.splitCamelCase ?? false;
  const unifySeparators = options.normalizeIdentifierSeparators ?? false;
  if (!splitCamel && !unifySeparators) return input;

  const base = input.text;
  const baseMap = input.map;
  const out: string[] = [];
  const map: number[] = [];
  const mapEnd: number[] = [];
  const back: number[] = [];
  const backOf = (at: number): number => {
    const b = input.back;
    if (!b || b.length === 0) return at;
    return b[Math.max(0, Math.min(at, b.length - 1))] ?? at;
  };
  let changed = false;

  /** 插入的分隔空格宽度为 0，不占用任何源码字符 */
  const writeSeparator = (at: number): void => {
    const k = Math.min(at, baseMap.length - 1);
    out.push(' ');
    map.push(baseMap[k]);
    mapEnd.push(baseMap[k]);
    back.push(backOf(at));
  };
  const writeChar = (ch: string, at: number): void => {
    out.push(ch);
    map.push(baseMap[at]);
    mapEnd.push(input.mapEnd ? input.mapEnd[at] : baseMap[at] + 1);
    back.push(backOf(at));
  };

  // ★ 复用子包的核心判定，避免「同一规则写两遍」。
  // 子包只负责"哪里该插入"，坐标映射由这里补齐 —— 这是本包的职责。
  const breaks = new Map<number, IdentifierBreak>(
    findIdentifierBreaks(base, { splitCamel, unifySeparators }).map((b) => [b.at, b])
  );

  let i = 0;
  while (i < base.length) {
    const brk = breaks.get(i);
    if (brk) {
      writeSeparator(i);
      changed = true;
      if (brk.kind === 'replace') {
        // 原字符（_ 或连字符）被分隔符取代，不再写出
        i += 1;
        continue;
      }
    }
    writeChar(base[i], i);
    i += 1;
  }

  if (!changed) return input;

  return appendTerminator(out.join(''), map, mapEnd, base.length, back);
}

// #endregion

// #region 阶段 3：大小写

/**
 * 大小写折叠。
 *
 * 用 `toLowerCase` 而非 `toUpperCase` —— `ß.toUpperCase()` 会变成 `SS`，
 * 长度改变、破坏下标映射。
 */
function foldCase(input: NormalizedText, options: NormalizeOptions): NormalizedText {
  if (options.ignoreCase === false) return input;
  const base = input.text;
  const lowered = base.toLowerCase();
  if (lowered === base) return input;
  if (lowered.length === base.length) return { ...input, text: lowered };
  // 极少数字符 lower 后长度会变（如 İ → i̇），此时必须重建映射
  const baseMap = input.map;
  const baseEnd = input.mapEnd ?? inferCharEndOffsets(baseMap, base);
  const map: number[] = [];
  const mapEnd: number[] = [];
  const back: number[] = [];
  for (let i = 0; i < lowered.length; i++) {
    const k = Math.min(i, baseMap.length - 1);
    map.push(baseMap[k]);
    mapEnd.push(baseEnd[k]);
    back.push(input.back ? input.back[Math.min(i, input.back.length - 1)] ?? i : i);
  }
  return appendTerminator(lowered, map, mapEnd, base.length, back);
}

// #endregion

// #region 阶段 4：标点 / 助词 / 空白

function foldPunctuationAndSpace(input: NormalizedText, options: NormalizeOptions): NormalizedText {
  const base = input.text;
  const baseMap = input.map;
  const baseEnd = input.mapEnd ?? inferCharEndOffsets(baseMap, base);
  const punct = normalizeIgnorePunctuationOption(options.ignorePunctuation);
  const dropSpace = options.dropSpaceBetweenCJK ?? true;
  // 保护区：调用方明确告知的省略表达不参与折叠 ——
  // 否则「忽略标点」会顺手抹掉结构性分隔符（见 ignorePunctuation.ts 的取舍说明）
  const keepRanges = markKeepRanges(base, punct.keep);

  // 助词判定在**本阶段的输入**上跑：位置必须与这里的下标对齐
  const foldable: ReadonlySet<number> | null =
    options.ignoreParticles === true
      ? sharedGuardListTagger().foldableAt(base)
      : options.ignoreParticles
        ? options.ignoreParticles.foldableAt(base)
        : null;

  const out: string[] = [];
  const map: number[] = [];
  const mapEnd: number[] = [];
  const back: number[] = [];
  const backOf = (at: number): number => {
    const b = input.back;
    if (!b || b.length === 0) return at;
    return b[Math.max(0, Math.min(at, b.length - 1))] ?? at;
  };
  let pendingWhitespace: number | null = null;
  let i = 0;

  const emit = (ch: string, at: number): void => {
    const k = Math.min(at, baseMap.length - 1);
    out.push(ch);
    map.push(baseMap[k]);
    mapEnd.push(baseEnd[k]);
    back.push(backOf(at));
  };

  while (i < base.length) {
    const cp = base.codePointAt(i) as number;
    const w = cp > 0xffff ? 2 : 1;

    if (WHITESPACE_PATTERN.test(String.fromCodePoint(cp))) {
      // 保护区里的空白同样保留原文：照字面写出，不折成占位符。
      // keep: [/\s+/] 组合 drop 档就是靠这一條才得到「只删标点、留词边界」。
      if (keepRanges?.[i]) {
        emit(base[i], i);
        i += w;
        continue;
      }
      if (pendingWhitespace === null) pendingWhitespace = i;
      i += w;
      continue;
    }
    if (pendingWhitespace !== null) {
      emit(FOLDED_PLACEHOLDER, pendingWhitespace);
      pendingWhitespace = null;
    }

    let buf = '';
    const raw = base.slice(i, i + w);
    for (const c of raw) {
      if (punct.enabled && !keepRanges?.[i] && punct.pattern!.test(c)) buf += FOLDED_PLACEHOLDER;
      else {
        // 助词折叠：必须先过词性判定器
        const folded = foldable?.has(i) ? CHINESE_PARTICLE_FOLD_MAP.get(c) : undefined;
        buf += folded ?? PUNCTUATION_FOLD_MAP.get(c) ?? c;
      }
    }
    if (buf.length > 0) for (let k = 0; k < buf.length; k++) emit(buf[k], i);
    i += w;
  }

  const folded = appendTerminator(out.join(''), map, mapEnd, base.length, back);
  if (!dropSpace) return folded;

  // 空白去留由两侧文字的「空格角色」决定，见 canDropSpaceBetween
  const text = folded.text;
  const textMap = folded.map;
  const textEnd = folded.mapEnd ?? inferCharEndOffsets(textMap, text);
  const textBack = folded.back;
  const drop = new Array<boolean>(text.length).fill(false);
  // drop 档：占位符一律删除，不看两侧脸色（连拉丁词边界的空格也一并丢）——
  // 调用方显式选择了「只留文字骨架」，不再由脚本角色替他决定哪些分隔符有价值
  const dropAll = punct.enabled && punct.mode === 'drop';
  for (let k = 0; k < text.length; k++) {
    if (text[k] !== FOLDED_PLACEHOLDER) continue;
    if (dropAll) {
      drop[k] = true;
      continue;
    }
    let p = k - 1;
    while (p >= 0 && text[p] === FOLDED_PLACEHOLDER) p--;
    let q = k + 1;
    while (q < text.length && text[q] === FOLDED_PLACEHOLDER) q++;
    /**
     * 边缘占位符串：一侧根本没有文字，它连「分隔」的职责都不成立，
     * 一律删除（等价于 trim）。
     *
     * 不删会留下一条隐蔽的不对称：同一串标点，在页面里因为后面还有文字
     * 而被这一阶段删掉，在摘录里因为落在末尾而保留 —— 于是
     * `ignorePunctuation: true` 反而比 `false` 更容易失配，
     * 与「忽略标点」的语义正好相反。
     */
    if (p < 0 || q >= text.length) {
      drop[k] = true;
      continue;
    }
    const left = text.codePointAt(p);
    const right = text.codePointAt(q);
    if (left === undefined || right === undefined) continue;
    if (canDropSpaceBetween(unicodeScriptOf(left), unicodeScriptOf(right))) drop[k] = true;
  }
  if (!drop.some(Boolean)) return folded;

  const kept: string[] = [];
  const keptMap: number[] = [];
  const keptEnd: number[] = [];
  const keptBack: number[] = [];
  for (let k = 0; k < text.length; k++) {
    if (drop[k]) continue;
    kept.push(text[k]);
    keptMap.push(textMap[k]);
    keptEnd.push(textEnd[k]);
    if (textBack) keptBack.push(textBack[k]);
  }
  return appendTerminator(kept.join(''), keptMap, keptEnd, base.length, textBack ? keptBack : null);
}

// #endregion

// #region 下标映射工具

/**
 * 建「逐 code unit 恒等映射」，作为流水线的起点。
 *
 * @remarks
 * 索引口径是 **code unit**（与 `indexOf` / `slice` 一致），
 * 但 `mapEnd` 必须按**字符**给 —— 代理对（Emoji、CJK 扩展 B…）占 2 个 unit，
 * 若写成 `i + 1` 会落在代理对中间，切出半个代理项。
 * 因此同一个字符的两个 unit 共享 `map`，`mapEnd` 都指向字符末尾。
 */
function createIdentityMap(src: string): NormalizedText {
  const n = src.length;
  const map: number[] = new Array(n + 1);
  const mapEnd: number[] = new Array(n + 1);
  const back: number[] = new Array(n + 1);
  let i = 0;
  while (i < n) {
    const cp = src.codePointAt(i) as number;
    const w = cp > 0xffff ? 2 : 1;
    const end = Math.min(i + w, n);
    for (let u = 0; u < w; u++) {
      map[i + u] = i;
      mapEnd[i + u] = end;
      back[i + u] = i;
    }
    i += w;
  }
  // 末尾哨兵：保证 map[len] 恒有定义
  map[n] = n;
  mapEnd[n] = n;
  back[n] = n;
  return { text: src, map, mapEnd, back };
}

/**
 * 输入只给了起始映射时，退化推算结束位置。
 *
 * @remarks
 * 宽度按 **code point** 取（代理对占 2 个 unit），
 * 否则会与 {@link createIdentityMap} 一样落在代理对中间。
 * 这是退化路径 —— 正常流程各阶段都会带上自己的 `mapEnd`。
 */
function inferCharEndOffsets(map: number[], text: string): number[] {
  return map.map((v, i) => {
    if (i >= text.length) return v; // 末尾哨兵
    const cp = text.codePointAt(i) as number;
    const w = cp > 0xffff ? 2 : 1;
    return Math.min(v + w, text.length);
  });
}

/**
 * 源码中**从 `at` 开始、宽 `w` 个 code unit 的那个字符**的结束下标。
 *
 * @remarks
 * 代理对（astral 字符：Emoji、CJK 扩展 B…）占 **2 个** code unit。
 * 此时 `ends[at]` 是**高代理项**的结束，落在字符中间 ——
 * 用它切片会得到半个代理项（`'\uD83D'`），渲染成乱码。
 * 必须取该字符**最后一个** code unit 的结束位置。
 */
function charEndOffset(ends: number[], at: number, w: number): number {
  return ends[Math.min(at + w - 1, ends.length - 1)];
}

/**
 * 补上终止哨兵，保证 `map[len]` 恒有定义。
 *
 * 有了它，`spanForNormalizedRange` 才能用 `map[end]` 直接取结束位置，
 * 不必在每处调用点判断越界。
 */
function appendTerminator(
  text: string,
  map: number[],
  mapEnd: number[],
  baseLen: number,
  back: number[] | null = null
): NormalizedText {
  if (map.length === 0) return { text, map: [0], mapEnd: [0], back: back && back.length ? back : undefined };
  const last = baseLen > 0 ? Math.min(baseLen - 1, map.length - 1) : 0;
  map.push(map[last]);
  mapEnd.push(mapEnd[last]);
  if (back) back.push(back[Math.min(last, back.length - 1)] ?? last);
  return { text, map, mapEnd, back: back ?? undefined };
}

// #endregion

