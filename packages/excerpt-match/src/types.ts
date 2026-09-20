/**
 * 统一返回契约与可插拔接口。
 *
 * 整个库只导出一种返回形状 —— {@link ExcerptMatch}。命中与否都返回它，
 * 未命中是 `{ kind: 'none', index: -1, length: 0, score: 0 }`，绝不返回 `null`。
 *
 * 为什么不用 `null`：「是否出自正文」不是布尔判断，而是带置信度的分层结论。
 * 返回 `null` 会强迫调用方丢掉「差一点命中」这个最有价值的信息 ——
 * 而「差一点」往往正是 OCR 噪声、排版差异、轻微改写的信号。
 *
 * @packageDocumentation
 */

import type { ParticleTagger } from '@isdk/zh-particles';
import type { ChineseNumeralParser } from '@isdk/normalize-text';
import type { NegationLexicon } from '@isdk/zh-negation';
import type { IgnorePunctuationOption } from '@isdk/normalize-text';
import type { PresetName } from './presets';

/**
 * 命中层级。从严格到宽松排列，调用方可按场景设阈值。
 *
 * | kind | 容忍什么 | 由谁实现 |
 * |---|---|---|
 * | `exact` | 无差异 | `indexOf` |
 * | `normalized` | 空白、全半角、标点、大小写、零宽字符 | 内置归一化 |
 * | `segmented` | 摘录自带省略号（`……`） | 内置锚点链 |
 * | `fuzzy` | 错字、多字漏字 | 外部匹配器（如 diff-match-patch） |
 * | `semantic` | 同义改写、句式变换 | 外部召回（embedding / BM25） |
 * | `none` | — | 未命中 |
 *
 * @remarks
 * `fuzzy` 与 `semantic` 只在传入 {@link MatchOptions.fallbacks} 或调用
 * `locateSemantic` 时才可能出现。不传就绝不会有任何模糊匹配。
 */
export type MatchKind =
  /** 逐字符相同（T0） */
  'exact' |
  /** 归一化后相同：空白 / 全半角 / 标点 / 大小写 / 零宽差异（T1） */
  'normalized' |
  /** 摘录自带省略号，按分段锚点定位（T2） */
  'segmented' |
  /** 由外部模糊匹配器命中：有错字或增删（T3） */
  'fuzzy' |
  /** 由外部语义召回命中：同义改写（T4） */
  'semantic' |
  /** 未命中 */
  'none';

/**
 * 定位结果。命中与未命中都是这个形状。
 *
 * @example
 * ```ts
 * const r = locateExcerpt(excerpt, text, { markdown: md });
 * if (!isHit(r)) return;
 * // 恒成立的坐标契约
 * const span = text.slice(r.index, r.index + r.length);
 * ```
 */
export interface ExcerptMatch {
  /**
   * 命中片段在 `text` 中的起始下标，即 `text[index]`。
   * 单位是 **UTF-16 code unit**（与 `String.prototype.slice` 一致）。
   * md 模式下这是 **md 源码**中的下标，不是渲染后文本的下标。
   */
  index: number;

  /**
   * 命中片段在 `text` 中的长度。
   * `text.slice(index, index + length)` 即命中片段。
   *
   * @remarks
   * md 模式下 length 是**源码长度**（含语法标记），大于渲染后字数。
   * 例如摘录「被告的行为已经构成根本违约」渲染 13 字，
   * 对应源码 `**被告**的行为已经构成[根本违约](http://a.b/c)` 共 33 字符。
   */
  length: number;

  /** 命中层级，见 {@link MatchKind} */
  kind: MatchKind;

  /**
   * 该命中是否**跨越了标点差异**（仅 `ignorePunctuation` 开启时可能为 `true`）。
   *
   * @remarks
   * 语义是「跨越了差异」，**不是**「折叠了标点」—— 后者在开启选项后会
   * 把所有命中都标上 true，调用方就无从区分了。
   *
   * 判定方式是：两侧各自按 `ignorePunctuation: false` 重新归一化再比较 ——
   * 文档侧是「命中片段 + 紧邻的边缘标点」（不跨块），摘录侧保持原样。
   * 若结果**不同**，说明是忽略标点才匹配上的：
   *
   * | 文档 | 摘录 | `punctFolded` |
   * |---|---|---|
   * | `本院认为，被告…。` | `本院认为，被告…。` | `false` —— 标点一致，`exact` 就能命中 |
   * | `本院认为，被告…。` | `本院认为。被告…，` | `true` —— 逗号与句号互换 |
   * | `本院认为，被告…。` | `本院认为被告…` | `true` —— 摘录完全没有标点 |
   * | `…根本违约：`（文档收冒号） | `…根本违约。` | `true` —— 边缘上的身份差异也算 |
   *
   * 两侧不对称是刻意的：归一化把文档片段的首尾标点当可选分隔符删掉了，
   * 所以文档侧要**补回**紧邻的边缘标点（否则「两边其实都有句号」会被误报、
   * 「文档冒号摘录句号」这种真差异会因落在边上被漏报）；摘录侧的标点
   * 本身就是要比对的内容，保持原样。
   *
   * 注意全半角、中英标点这类**宽度差异不算**：它们由 `ignoreWidth` 处理，
   * 属于 T1 的常规归一，不需要人工复核。
   *
   * 用途：让调用方把「严格命中」与「靠忽略标点才命中」分开处理，
   * 后者送人工复核而非直接引用。
   *
   * @example
   * ```ts
   * const r = locateExcerpt(ex, text, { markdown: md, ignorePunctuation: true });
   * if (r.kind === 'exact' || (r.kind === 'normalized' && !r.punctFolded)) {
   *   cite(r);               // 只有严格命中才直接引用
   * } else if (isHit(r)) {
   *   flagForHumanReview(r); // 跨过标点差异 → 人工复核
   * }
   * ```
   */
  punctFolded?: boolean;

  /**
   * 置信度，0~1。1 表示完全一致。
   * `exact` / `normalized` / `segmented` 恒为 1；`fuzzy` / `semantic` 由外部匹配器给出。
   */
  score: number;

  /**
   * 该摘录在文本中出现的次数（上限 50）。
   *
   * @remarks
   * `> 1` 表示摘录太短或太常见，**存在歧义**，此时 `index` 指向第一个。
   * 调用方应据此判断能否安全使用该坐标（例如高亮、引用校验）。
   *
   * @example
   * ```ts
   * const r = locateExcerpt('中国市场', text);
   * if (r.occurrences > 1) console.warn('摘录有歧义，命中了', r.occurrences, '处');
   * ```
   */
  occurrences: number;

  /**
   * 命中片段是否跨越多个块（段落 / 标题 / 表格…）。
   * 由几何判定：span 与几个「有文本的块」相交。
   * 仅 md 模式下有值。
   */
  crossesBlocks?: boolean;

  /**
   * 命中来自哪个 fallback。仅 `kind` 为 `fuzzy` / `semantic` 时有值，
   * 值即 {@link FallbackMatcher.name}。语义层还会是 `'semantic'` 或 `'semantic:segment'`。
   */
  via?: string;
}

/**
 * 是否命中。比 `m.kind !== 'none'` 更可读的守卫。
 *
 * @example
 * ```ts
 * const r = locateExcerpt(ex, text);
 * if (isHit(r)) highlight(r.index, r.length);
 * ```
 */
export function isHit(m: ExcerptMatch): boolean {
  return m.kind !== 'none';
}

/** 未命中的规范返回值。复用同一个对象实例，避免每次分配。 */
export const NO_MATCH: ExcerptMatch = { index: -1, length: 0, kind: 'none', score: 0, occurrences: 0 };

/**
 * 归一化文本 + 下标映射。
 *
 * @remarks
 * 定义**已下沉到 `@isdk/normalize-text`** —— 它是为坐标映射才存在的类型，
 * 放在归一化包里才合理。这里 re-export 以保持主包 API 不变。
 */
export type { NormalizedText } from '@isdk/normalize-text';
import type { NormalizedText } from '@isdk/normalize-text';


/**
 * md 摊平相关的类型**只在 `@isdk/md-flatten` 定义一份**，这里 re-export。
 *
 * @remarks
 * 这里曾经各有一份结构相同的副本。TS 的结构类型让它照样能编译，
 * 代价是：子包加字段时主包不会跟着变，**也不报错** —— 典型的静默漂移。
 *
 * 改用 re-export 后是单一事实来源，主包对外 API 不变。
 */
export type {
  MarkdownFlattener,
  FlatResult,
  FlatBlock,
  InlineConstruct,
} from '@isdk/md-flatten';
import type { MarkdownFlattener } from '@isdk/md-flatten';

/**
 * 匹配选项。
 *
 * @example 严格模式（引用校验 / 取证）
 * ```ts
 * locateExcerpt(ex, text, { markdown: md }); // 不传 fallbacks，纯确定性
 * ```
 *
 * @example 宽松模式（高亮 / 笔记锚定）
 * ```ts
 * locateExcerpt(ex, text, { markdown: md, fallbacks: [fuzzy], minFallbackScore: 0.85 });
 * ```
 */
export interface MatchOptions {
  /**
   * 预设档位，一次性决定一组选项；**显式传入的其它项会覆盖预设**。
   *
   * @remarks
   * 25 个配置项里多数是按场景决定的，不必每次调用都重新权衡。
   *
   * | 档位 | 适用 | 取舍 |
   * |---|---|---|
   * | `strict` | 引用校验 / 取证 | 宁可漏不可错，只走 T0–T2 |
   * | `default` | 高亮 / 锚定 / 笔记 | 平衡 |
   * | `loose` | 查重 / 召回 | 尽量命中，靠 `score` 排序 |
   *
   * @example
   * ```ts
   * locateExcerpt(ex, text, { preset: 'strict' });
   * locateExcerpt(ex, text, { preset: 'loose', ignorePunctuation: false });
   * ```
   */
  preset?: PresetName;

  /**
   * 语言代码，影响空白处理与分词粒度。
   * 传 `'auto'` 或不传则由 {@link detectLanguageProfile} 自动探测
   * （CJK / 泰文字符占比 > 20% 走 CJK 策略）。
   * @defaultValue `'auto'`
   */
  locale?: string;

  /**
   * 是否忽略大小写。
   * @defaultValue `true`
   */
  ignoreCase?: boolean;

  /**
   * 是否忽略标点。除了布尔值，还支持 `'drop'` 与对象写法
   * （见 {@link IgnorePunctuationOption}）—— 它们回答三个不同问题：
   *
   * | 写法 | 含义 |
   * |---|---|
   * | `true` | 折成占位符，删不删交给文字的空格角色裁决 |
   * | `'drop'` | 占位符一律删除：只留文字骨架（查重场景） |
   * | `{ symbols: true }` | 把 `` ` + = ~ `` 这类符号也算标点 |
   * | `{ keep: [/\s+/] }` | 只折标点，保留词边界 |
   *
   * @remarks
   * 默认关闭。开启后 `不，是` 与 `不是` 会等价 ——
   * 中文标点常常载义（`禁止，吸烟` ≠ `禁止吸烟`），请按需开启。
   *
   * **省略表达默认受保护**：摘录里用户 / 系统写下的 `……` 属于结构性分隔符，
   * 不会因为开启本开关而被抹掉（否则 T2 分段锚点会随之失效）；
   * 确要一并折叠时显式写 `{ preserveEllipsis: false }`。
   * @defaultValue `false`
   */
  ignorePunctuation?: IgnorePunctuationOption;

  /**
   * 是否做 NFKC 折叠（全角→半角、`ﬁ`→`fi`、`①`→`1`）。
   * @defaultValue `true`
   */
  ignoreWidth?: boolean;

  /**
   * 是否归一数字分组分隔符：`1,000` ≡ `1000`。
   *
   * @remarks
   * 在 NFKC 之后、标点折叠之前执行，所以全角 `1，000` 也能识别，
   * 而顿号 `1、000` 不会（顿号是列表分隔符，不被 NFKC 折叠）。
   * @defaultValue `true`
   */
  numberGrouping?: boolean;

  /**
   * 是否也把 `_` 当作数字分组分隔符（`1_000` ≡ `1000`）。
   * @remarks 默认关闭：`_` 更常见的身份是标识符的一部分。
   * @defaultValue `false`
   */
  groupingUnderscore?: boolean;

  /**
   * 是否把中文数词转成阿拉伯数字（`一千` ≡ `1000`）。
   *
   * @remarks
   * 默认关闭：这是换了一套**数词系统**而非同一种表示法，
   * 且存在语义歧义（`三思而行` 里的「三」不是数词）。
   * @defaultValue `false`
   */
  cjkNumerals?: boolean;

  /**
   * 中文数词解析后端，开启 `cjkNumerals` 时需要注入。
   *
   * @remarks
   * 本库核心不自带中文数词解析 —— 那是另一个领域，交给 `cjk-number` 这类专门库。
   * 请注入 {@link createCjkNumberParser} 的结果。
   *
   * 低层 API（`locateExcerpt` / `createTextIndex`）**必须注入**；
   * 高层 API（`matchExcerpt` / `createExcerptMatcher`）不传时**自动装配**
   * 内置的 `cjk-number` 解析器（见 `defaultCjkNumberParser`）。
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
  cjkNumeralParser?: ChineseNumeralParser;

  /**
   * 是否把驼峰标识符拆成带空格的形式（`HelloWorld` → `Hello World`）。
   *
   * @remarks
   * 方向刻意选**拆分**而非合并：自然文本里不会出现两个词紧贴无空格，
   * 所以「无空格 + 驼峰」是标识符的强信号；反之据「有空格 + 驼峰」删空格
   * 会误伤 `Hello World` 这类普通词组。
   * @defaultValue `false`
   */
  splitCamelCase?: boolean;

  /**
   * 是否把标识符里的 `_` / `-` 视为空格（`hello_world` ≡ `hello world`）。
   *
   * @remarks
   * 只在两侧都是 `[A-Za-z0-9]` 时生效，
   * 所以 `北京-上海` 不会被拆（那会把两个地名并成一个）。
   * @defaultValue `false`
   */
  normalizeIdentifierSeparators?: boolean;

  /**
   * 是否允许 T2 省略号分段锚点。
   * @defaultValue `true`
   */
  allowSegmented?: boolean;

  /**
   * T2 用于切分锚点的省略号模式，支持多个。
   *
   * 字符串按**字面量**匹配（内部会转义，传 `'...'` 不会被当成正则）；
   * 正则按原样使用，可写 `/\.{3}/` 这类精确控制的形式。
   * 每个模式两侧的空白都会被忽略。
   *
   * @remarks
   * 传了就**覆盖**默认模式。想保留默认只需 concat：
   * ```ts
   * import { DEFAULT_ELLIPSIS } from './src';
   * locateExcerpt(ex, text, { ellipsis: [...DEFAULT_ELLIPSIS, '〔中略〕', /\[\s*snip\s*\]/] });
   * ```
   * 传空数组等价于关闭 T2（而不是退化成「处处可切」）。
   *
   * **注意**：切分发生在归一化之后，而归一化会做 NFKC 折叠
   * （`〔中略〕` → `[中略]`）。字符串模式会先过同样的归一化再匹配，
   * 因此写全角或半角都能命中；正则则作用在归一化后的文本上。
   *
   * @defaultValue {@link DEFAULT_ELLIPSIS}
   */
  ellipsis?: readonly EllipsisPattern[];

  /**
   * `text` 是 markdown 源码时的摊平器。
   *
   * @remarks
   * - **不传** —— 高层 API（`matchExcerpt` / `createExcerptMatcher`）自动使用
 *   内置默认摊平器（mdast + GFM，见 `defaultMarkdownFlattener`）；
   *   低层 API（`locateExcerpt` / `createTextIndex`）视为纯文本。
   * - **传 `null`** —— 强制按纯文本处理（文档里的 `**` 是字面内容）。
   * - **传摊平器** —— 用你的（自定义扩展、私有能力等）。
   *
   * md 语法（`**`、`[](url)`、`|`、`#`）在渲染后都不存在，
   * 不摊平的话摘录几乎必然匹配失败。
   * @example
   * ```ts
   * const md = createMdastFlattener(fromMarkdown, {
   *   extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()],
   * });
   * ```
   */
  markdown?: MarkdownFlattener | null;

  /**
   * 摘录本身是否也是 markdown（从 md 源码而非渲染后文档复制）。
   * @defaultValue `false` —— 默认摘录来自渲染后文档
   */
  excerptIsMarkdown?: boolean;

  /**
   * 是否修剪命中 span 首尾的 md 语法标记。
   * @defaultValue `false` —— 精确优先，修剪会破坏刚补齐的标记
   */
  trimMarkdownEdges?: boolean;

  /**
   * span 是否向外扩展到完整的行内标记（`**…**`、`[..](..)` 这类）。
   *
   * @remarks
   * 开启后摘录「被告」的 span 是 `**被告**` 而非 `被告`，
   * 避免切出渲染后强调丢失的非法片段。
   * @defaultValue `true`
   */
  expandMarkers?: boolean;

  /**
   * 摘录不带分隔符时是否允许跨块匹配。设为 `false` 等价于 `maxCrossBlocks: 1`。
   *
   * @remarks
   * 用户复制跨段内容时常丢换行（「上一段末尾。下一段开头」），
   * 而源码里两段之间有分隔符，严格比对必然失败。
   * @defaultValue `true`
   */
  allowCrossBlock?: boolean;

  /**
   * 命中最多允许跨越多少个块。
   *
   * @remarks
   * 只强制「连续、不跳过」，不限制段数（连续三段仍算相邻）。
   * 命中必须落在**连续的一段**块上；隔了整段的摘录会被拒绝 ——
   * 那是省略号场景（T2），不是跨块。
   *
   * @defaultValue `Infinity`
   * @example 只跨相邻两段
   * ```ts
   * locateExcerpt(ex, text, { markdown: md, maxCrossBlocks: 2 });
   * ```
   */
  maxCrossBlocks?: number;

  /**
   * T3 / T4 兜底匹配器，按数组顺序依次尝试（前面的更「硬」，命中即停）。
   *
   * @remarks
   * 低层 API（`locateExcerpt` / `createTextIndex`）：不传则完全不会有模糊匹配。
   * 高层 API（`matchExcerpt` / `createExcerptMatcher`）：不传时默认注入内置的
   * `diff-match-patch-es` 模糊匹配器（`preset: 'strict'` 除外；显式传
   * `fallbacks: []` 可在任何档位关闭）。
   */
  fallbacks?: readonly FallbackMatcher[];

  /**
   * 交给 fallback 的最低分数门槛，低于此值视为未命中。
   * @defaultValue `0.75`
   */
  minFallbackScore?: number;

  /**
   * 是否对 T3 / T4 的命中做**极性检查**：摘录与命中片段一个肯定、一个否定时，判为未命中。
   *
   * 为什么需要：字符相似度区分不了「少个虚词」和「多个否定词」——
   * ```
   * 原文 : 人工智能正在改变世界
   * 摘录A: 人工智能在改变世界    0.947  ← 等价，接受
   * 摘录B: 人工智能没在改变世界  0.900  ← 相反，必须拒绝
   * ```
   * 两者只差 0.047，调阈值无解。而「有没有否定词」是确定的，词表即可判定。
   *
   * @remarks
   * 只在 T3 / T4 生效。T0–T2 是字面匹配，极性天然一致（原文真是否定句时摘录也带否定词）。
   * 判据是**否定标记个数的奇偶**，双重否定（`不得不`）算肯定。
   *
   * @defaultValue `true`
   */
  checkPolarity?: boolean;

  /**
   * 否定判定的**领域词表**，用于覆盖内置默认值。
   *
   * @remarks
   * 多义词（如「未来」既可能是时间名词，也可能是「没有来」的省略）
   * 无法脱离上下文判断 —— 那是词义消歧（WSD），超出本库范围。
   *
   * 本库的立场是**保守默认 + 允许覆盖**：
   * 默认把这类词按「非否定」处理（宁可漏判，不可误判），
   * 调用方可按自身语料的特点覆盖。见 {@link NegationLexicon}。
   */
  negationLexicon?: NegationLexicon;

  /**
   * 中文结构助词「的 / 地 / 得」的折叠策略。
   *
   * - `false`（默认）—— 不折叠。**最安全**，零误判。
   * - `true` —— 内置保守模式（实词保护表）。零依赖，但保护表补不全。
   *   高层 API（`matchExcerpt` / `createExcerptMatcher`）会自动**升级**为
   *   内置 jieba 词性判定器（见 `defaultParticleTagger`）；低层 API 保持保守模式。
   * - {@link ParticleTagger} —— 词性感知的精确判定。推荐
   *   `createJiebaParticleTagger(jieba)`（基于 `@isdk/nlp-jieba`，词典驱动）。
   *
   * @remarks
   * **为什么需要词性**：无脑折叠会让「辽阔的大地」匹配上「辽阔的大的」，
   * 且 `score = 1.00`。`大地` 与 `大的` 是两个词，不是同一个词的两种写法 ——
   * 这与全半角折叠有本质区别。
   *
   * 折叠是 1→1 的，不改变长度，坐标映射不受影响。
   * @defaultValue `false`
   */
  ignoreParticles?: boolean | ParticleTagger;

  /**
   * T2 分段锚点的最短长度。
   *
   * @remarks
   * 太短的碎片会散布全篇，拼出一个荒谬的超长 span。
   * @defaultValue `4`
   */
  minSegmentLength?: number;

  /**
   * T2 分段之间允许的最大间隔（归一化字符数）。
   * @defaultValue `Infinity`
   */
  maxGap?: number;
}

/**
 * T3 / T4 的可插拔接口 —— 这是本库与 NLP 世界的边界。
 *
 * 契约：只负责「在归一化文本里找出像的片段」，返回**归一化空间**的 `[start, end)`。
 * 坐标回切、原文 span、字形簇对齐由 locator 统一负责。
 *
 * 这样设计的好处：adapter 可以用任何库（diff-match-patch / fuzzysort / embedding），
 * 都不需要关心我们的归一化规则和坐标系。
 *
 * @example 自定义 fallback
 * ```ts
 * const myFallback: FallbackMatcher = {
 *   name: 'my-model',
 *   kind: 'semantic',
 *   find(needle, hay, ctx) {
 *     const tokens = ctx.tokenize(hay.text);
 *     // …返回 [{ start, end, score }]
 *   },
 * };
 * ```
 */
export interface FallbackMatcher {
  /** 匹配器名称，会出现在 {@link ExcerptMatch.via} 上，便于排查 */
  readonly name: string;

  /** 决定命中后 {@link ExcerptMatch.kind} 的值 */
  readonly kind: 'fuzzy' | 'semantic';

  /**
   * 在归一化文本中查找。
   * @param needle 归一化后的摘录    * @param hay 归一化后的文档文本（含下标映射）
   * @param ctx 语言与门限上下文
   * @returns 候选区间列表（归一化空间），或 null 表示无
   */
  find(needle: string, hay: NormalizedText, ctx: MatchContext): Candidate[] | null;
}

/** 传给 {@link FallbackMatcher.find} 的上下文 */
export interface MatchContext {
  /** 探测或指定的语言 id */
  locale: string;
  /**
   * 语言策略提供的分词器，供需要 token 的 adapter 使用。
   * 中文按字切，英文按词切，日 / 韩 / 泰走 ICU。
   */
  tokenize(text: string): string[];
  /** 当前的最低分数门槛 */
  minScore: number;
}

/**
 * 省略号模式。字符串按字面量匹配，正则按原样使用。
 * 见 {@link MatchOptions.ellipsis}。
 */
export type EllipsisPattern = string | RegExp;

/** 重新导出，方便调用方从入口一次性拿到 */
export type { ParticleTagger };


/** 归一化空间中的候选区间 */
export interface Candidate {
  /** 起始下标（含） */
  start: number;
  /** 结束下标（不含） */
  end: number;
  /** 置信度 0~1 */
  score: number;
}

/**
 * 默认的省略号模式。覆盖常见中英文与日文写法：
 *
 * | 形式 | 例子 |
 * |---|---|
 * | 连续句点 / 句号 | `...` `。。。` `......` |
 * | 省略号字符 | `…` `……` |
 * | 方括号包裹的「略」 | `〔略〕` `[略]` `【略】` `〔…〕` `[...]` |
 */
export const DEFAULT_ELLIPSIS: readonly EllipsisPattern[] = [
  /[.．。]{2,}/, // 两个及以上的句点或句号
  /…+/, // 一个或多个省略号字符
  /[〔\[【]\s*[.．…略]+\s*[〕\]】]/, // 〔略〕 / [...] / 【…】
];
