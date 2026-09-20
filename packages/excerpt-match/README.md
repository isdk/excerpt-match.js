# excerpt-match

[English](./README.en.md) | 中文

判断一段摘录是否出自文档正文，并定位到**原文（markdown 源码）中的精确位置与长度**。

分层匹配、语言无关、核心零依赖。

---

## 它解决什么问题

`text` 是 markdown **源码**，而摘录是用户从**渲染后文档**复制的。中间隔着一层渲染：

```
md 源码 : 本院**认为**被告构成[根本违约](http://x.com)。
渲染结果: 本院认为被告构成根本违约。
复制得到: 本院认为被告构成根本违约。
```

直接 `indexOf` 必然失败 —— `**`、`[](url)` 这些语法在渲染后都不存在。
本库先把 md 摊平成「渲染后可见文本」，同时**保留每个字符到源码的精确映射**，
因此既能在可见文本上比对，又能回切出源码坐标。

> **术语约定**：本库处理的是**一篇文档**（markdown 源码或纯文本），没有页 / 分页的概念；
> 下文的「渲染后文档」就是源码渲染出来的内容，摘录从那里复制而来。

## 三档预设

25 个配置项里多数是按场景决定的，不必每次调用都重新权衡。`preset` 一次选好，
**显式传入的其它项会覆盖预设**：

```ts
locateExcerpt(ex, text, { preset: 'strict' });
locateExcerpt(ex, text, { preset: 'loose', ignorePunctuation: false });
```

| 档位 | 适用 | 核心取舍 |
|---|---|---|
| `strict` | 引用校验 / 取证 | 宁可漏不可错。不跨块、不接受分段锚点、无模糊匹配 |
| `default` | 高亮 / 锚定 / 笔记 | 平衡。允许分段锚点与跨块 |
| `loose` | 查重 / 召回 | 尽量命中，靠 `score` 排序。忽略标点、合并标识符变体 |

三档都保持 `checkPolarity: true`，且都**不**开启 `cjkNumerals` 与 `ignoreParticles` ——
前者会让不同词收敛成同一串（假命中来源），后者是错字而非语义等价。

## 快速开始

```bash
npm install @isdk/excerpt-match
```

高层入口**零配置可用** —— md 摊平（mdast + GFM）、T3 模糊层（diff-match-patch-es）
等依赖已随包必装并自动装配：

```ts
import { matchExcerpt } from '@isdk/excerpt-match';

const r = await matchExcerpt('本院认为，被告的行为构成违约', mdSource);

if (r.found) {
  // 坐标契约恒成立；source 就是可引用的 md 源码片段
  console.log(r.kind, r.score, mdSource.slice(r.index, r.index + r.length));
}
```

一篇文档查**多条**摘录时，务必复用索引（见 [性能](#性能)）：

```ts
import { createExcerptMatcher } from '@isdk/excerpt-match';

const m = await createExcerptMatcher(mdSource);
for (const it of items) it.ok = (await m.match(it.excerpt)).found;
```

只要坐标不要结论的同步入口是 `locateExcerpt` —— 它保持**核心零依赖、显式注入**：

```ts
import { locateExcerpt } from '@isdk/excerpt-match';
import { createMdastFlattener } from '@isdk/md-flatten';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

// 摊平器显式传入（低层 API 不自动装配）
const md = createMdastFlattener(fromMarkdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
});

const r = locateExcerpt('本院认为，被告的行为构成违约', mdSource, { markdown: md });

if (r.kind !== 'none') {
  const span = mdSource.slice(r.index, r.index + r.length);
  console.log(r.kind, r.score, span);
}
```

## 返回契约

命中与否都返回同一个形状，**从不返回 `null`**：

```ts
interface ExcerptMatch {
  index: number;          // 在 text 中的起始下标
  length: number;         // 长度；slice(index, index+length) 即命中片段
  kind: MatchKind;        // 命中层级
  score: number;          // 0~1，1 = 完全一致
  occurrences: number;    // 出现次数；>1 表示有歧义
  crossesBlocks?: boolean; // 是否跨块（仅 md 模式）
  via?: string;           // 来自哪个 fallback
}
```

未命中：`{ kind: 'none', index: -1, length: 0, score: 0 }`（即 `MISS`）。

> 为什么不用 `null`：「是否出自正文」不是布尔判断，而是带置信度的分层结论。
> 返回 `null` 会丢掉「差一点命中」这个最有价值的信息 —— 而「差一点」
> 往往正是 OCR 噪声、排版差异或轻微改写的信号。

## 分层

| 层 | kind | 容忍什么 | 实现 |
|---|---|---|---|
| T0 | `exact` | 无差异 | 在可见文本上 `indexOf` |
| T1 | `normalized` | 空白 / 全半角 / 标点 / 大小写 / 零宽字符 | 内置归一化 |
| T2 | `segmented` | 摘录自带省略号（`……`） | 内置锚点链 |
| T3 | `fuzzy` | 错字、多字漏字 | 默认内置（diff-match-patch-es）；可注入自定义 |
| T4 | `semantic` | 同义改写、句式变换 | 外部召回（embedding / BM25） |
| — | `none` | — | 未命中 |

**T3 / T4 的开关**：高层入口（`matchExcerpt`）默认注入内置 T3 模糊层，
`preset: 'strict'` 或显式 `fallbacks: []` 可关闭；低层入口（`locateExcerpt`）
不传 `fallbacks` 就绝不会有任何模糊匹配。T4 只在给了 `retriever` 时才可能发生。
严格场景（引用校验、取证）拿到的就是纯确定性结果。

### 按场景选配置

| 场景 | 建议 |
|---|---|
| 引用校验 / 取证 | 不传 `fallbacks`，只走 T0–T2 |
| 高亮 / 笔记锚定 | `fallbacks: [fuzzy]`，`minFallbackScore: 0.85` |
| 查重 / 语义召回 | 全开，按 `kind + score` 排序，语义层另起一路 |

## 坐标契约

`index` / `length` 是 **text 中的精确位置与长度**。

- md 模式下 `length` 是**源码长度**（含语法标记），大于渲染后字数：
  摘录「被告的行为已经构成根本违约」渲染 13 字 → 源码
  `**被告**的行为已经构成[根本违约](http://a.b/c)` 共 33 字符。
- 每个字符存两份坐标 `map` / `mapEnd`。`mapEnd` 不可由 `map` 推算 ——
  转义（`\*` → `*`）与实体（`&amp;` → `&`）让一个可见字符横跨多个源码字符。
- span 默认向两侧补齐**完整的行内标记**，避免切出 `被告**的行为` 这种半截片段：
  摘录「被告」→ span 是 `**被告**`。

### 已知边界

摘录若起止于行内构造**中间**（如只取到 `[根本违约](url)` 的「根本」），
「精确」和「独立可渲染」不可兼得 —— 补上 `](url)` 会多出「违约」，不补就是半截链接。
本库选**精确**；需要合法片段时可按 `TextIndex.blocks` 自行外扩。

## Markdown 摊平

用 **mdast** 而不是正则：

- 每个节点自带 `position.offset`，天然就是我们要的下标映射
- 「什么算渲染后可见」由解析器决定，不用猜
- 表格、删除线、脚注、转义这些正则写不对的东西都免费

几个反直觉但正确的取舍：

- **图片的 alt 不保留** —— 渲染成 `<img>`，用户复制不到文字
- 链接只留锚文本，URL 丢弃
- front matter、HTML 残留、注释、表格 `|`、标题 `#` 全部丢弃
- 只含图片的块不算「块」（不产生文本），跨块相邻性判定时会跳过

> **GFM 必须同时装两个包**，它们不是二选一，而是分层搭档：
>
> | 包 | 层 | 职责 |
> |---|---|---|
> | `micromark-extension-gfm` | 词法/语法层 | 把 `\| a \| b \|` 切成 tokens |
> | `mdast-util-gfm` | AST 层 | 把 tokens 转成 `table` / `tableRow` 节点 |
>
> `fromMarkdown` 有两个不同的插槽：`extensions:`（语法侧）与
> `mdastExtensions:`（AST 侧），两者都要填。只装 `mdast-util-gfm` 的话，
> tokenizer 不认识表格语法，`table` 节点永远出不来。
>
> 两个包都属 unified 官方生态、同版本线（都是 `^3`），且**均未废弃**
> （`micromark-extension-gfm@3.0.0` 发布于 2025-03）。
> `remark-gfm@4.0.1` 内部正是同时依赖这两个包。
>
> 不用 `remark-gfm` 是因为它走 unified 管线，而我们需要
> `mdast-util-from-markdown` 直接提供的 `position.offset` —— 那是精确坐标的来源。

无法引入 mdast 时可用零依赖的 `regexFlattener`，但表格 / 嵌套 / 转义处理不干净，
坐标是近似值 —— 不是推荐路径。

### 什么是「块」？

本库的「块」是 **Markdown 的块级元素**（mdast 的 `paragraph` / `heading` / `code` / `table`），
比「回车分段」严格：

| 源码写法 | 块边界 |
|---|---|
| 段落：两行文字中间**空一行** | 空行是边界 |
| 段内一个回车（软换行） | **不是**边界，渲染成同一段 |
| `## 标题` | 标题自成一个块，前后不必空行 |
| ```代码块``` / 表格 | 各自成一个块 |

「块」和「段落」大部分时候是一回事，但标题、代码块、表格、列表项也各占一个块 ——
引用块、列表这类**容器还可以嵌套**，内层的段落同样是独立的块。

摊平后，块与块之间插入一个分隔符 `\n`（排版产物，不是内容），
并记录每个块的边界（`blocks`）。这个概念贯穿三处行为：

1. **块边界是归一化的止点** —— 首尾标点、空白在块内可折叠，但不跨块吞并；
2. **跨块匹配的相邻性按块计算** —— 见下一节；
3. **`punctFolded` 的边缘标点扩展不跨块** —— 见[`punctFolded`](#punctfolded区分「严格命中」与「靠忽略标点才命中」)一节的「止于块边界」。

## 跨块摘录

用户复制跨段内容时常**不带换行**：

```
md   : 第一段末尾内容。\n\n第二段开头内容。
摘录 : 第一段末尾内容。第二段开头内容。
```

更一般的场景：摘录横跨标题、段落、代码块、列表项 —— 任何「渲染后看起来
连续、源码里却隔着块边界」的内容（块的概念见上节）。复制从渲染后文档出发，感知不到块的存在。

块间分隔符是我们插入的排版产物，不是内容。所以除严格视图外，
再派生一份**无分隔符视图**，两个视图一起参与匹配。

### 只跨相邻块，绝不跳过

- 命中必须落在**连续的一段**块上。隔了整段（`甲 / 中间整段 / 乙`）的摘录判 `none` ——
  那是省略号场景（T2），不是跨块。
- 相邻性按**有文本的块**计算：图片块、分隔线不产生文本，不算被跳过。
- `maxCrossBlocks` 限制最多跨越几块：

| 值 | 含义 |
|---|---|
| 默认 `Infinity` | 只强制连续，不限段数（连续三段仍算相邻） |
| `2` | 只允许跨相邻两段 |
| `1` 或 `allowCrossBlock: false` | 完全禁止跨块 |

### 取最早，而不是最强

两个视图的候选一起比较，**位置优先于强度**：

```
甲\n\n乙\n\n后面段落里字面出现了甲乙两字。
摘录「甲乙」→ 命中前面的 甲\n\n乙（index 0），
              而不是后面那个字面「甲乙」（index 16）
```

否则 T0 精确匹配一旦在后面命中就短路，会把更靠前的跨块匹配盖掉。
同位置时再按强度取：`exact` > `normalized` > `segmented`。

### 自定义省略号（T2）

默认支持 `...` `。。。` `…` `〔略〕` `[...]` 等常见写法。可完全自定义，支持多个：

```ts
import { DEFAULT_ELLIPSIS } from './src';

// 覆盖默认
locateExcerpt(ex, text, { ellipsis: ['〔中略〕', /\[\s*snip\s*\]/] });

// 保留默认 + 追加
locateExcerpt(ex, text, { ellipsis: [...DEFAULT_ELLIPSIS, '〔中略〕'] });

// 关闭 T2
locateExcerpt(ex, text, { ellipsis: [] });
```

字符串按**字面量**匹配（内部转义，传 `'...'` 不会被当成正则）；
正则按原样使用。每个模式两侧的空白都会被忽略。

> ⚠️ **一个反直觉的点**：切分发生在归一化**之后**，而归一化会做 NFKC 折叠
> （`〔中略〕` → `[中略]`，`，` → `,`）。所以字符串模式会先过一遍同样的归一化
> 再匹配 —— 写全角或半角都能命中。正则则作用在归一化后的文本上，写正则时要按
> 归一化后的形式来。

### 风险

短摘录跨块可能歧义：`甲\n\n乙\n\n甲\n\n乙` 中「甲乙」有三处都能拼上。
实现保证返回**第一个**，同时 `occurrences` 会报出总数，调用方据此判歧义。

## 语义等价 vs 语义相反

这是整个库最容易踩的坑。先看实测数据：

```
原文   : 人工智能正在改变世界
摘录 A : 人工智能在改变世界     0.947  ← 语义等价，应接受
摘录 B : 人工智能没在改变世界   0.900  ← 语义相反，应拒绝
```

**两者只差 0.047。** 字符相似度区分不了「少了个虚词」和「多了个否定词」——
两种情况下字面重叠度都很高。这不是调阈值能解决的，而是**相似度与蕴含（NLI）
两种任务的差异**：余弦/字符距离衡量「像不像」，而我们要的是「意思一不一致」。

解决办法不是上模型，而是先做一件确定的事：**查否定词**。

```
checkPolarity: true（默认）
  人工智能在改变世界    → fuzzy 0.947  ✅
  人工智能没在改变世界  → none         ✅
```

`detectPolarity` 用中英文否定词表（最长匹配，`没有` 不会被拆成两个单字），
按**否定标记个数的奇偶**判断极性 —— 双重否定（`不得不`）算肯定。

三个设计细节：

- **只比较命中 span 内的原文**，不用全文。文档别处有「不」很正常，
  但落在 span 外就不该影响判断。
- **只比较奇偶，不比较具体用词**。「不去」与「没去」用词不同但同为否定，不算冲突。
- **只在 T3 / T4 生效**。T0–T2 是字面匹配，极性天然一致
  （原文真是否定句时，摘录也必然带着那个否定词）。

判据是**否定词必须是独立的词**，由 `Intl.Segmenter` 分词保证：

```
非常 → Segmenter 切成 ["非常"] 整体  → 不是否定  ✅
无锡 → ["无锡"]                    → 不是否定  ✅
没有 → ["没有"]                    → 否定      ✅
不去 → ["不去"]（切分不一致，故额外允许
      「以单字否定词开头且 ≤2 字」）  → 否定      ✅
```

英文缩写用**词形**判定（`don't` 作为一个词，或以 `n't` 结尾），
所以 `don't` / `doesn't` / `isn't` 都能识别，而 `notice` / `noon` 不误判。

排除表按**整个词**匹配而非前缀 —— 前缀会误杀 `无法` / `无论` 这些真正的否定词。

守卫放在**候选过滤**阶段而非命中之后 —— 否则会出现「最高分候选极性冲突 → 直接 MISS」，
而次优候选其实合法的情况。

> 已知边界：否定词的**作用域**没有建模。`他没有说不去` 会被算作双重否定，
> 而实际语义并非如此。这类结构罕见，且守卫的行为是可预测的（保守拒绝）。

## 中文的「的 / 地 / 得」：必须看词性

### 无脑折叠是错的

这三个字作**助词**时混用极普遍，但作**实词**时（大地 / 土地 / 得到 / 值得）
绝不能折叠。**`大地` 与 `大的` 是两个词，不是同一个词的两种写法** ——
这与全半角折叠有本质区别。

上一版无脑折叠，实测误判：

```
「辽阔的大地」 ← 「辽阔的大的」     normalized  score 1.00  ← 误判
「这片土地」   ← 「这片土的」       normalized  score 1.00  ← 误判
「值得信赖」   ← 「值的信赖」       normalized  score 1.00  ← 误判
```

更糟的是 `score = 1.00`：系统在宣称「两段文本完全一致」，而它们并不一致。
在引用校验 / 取证场景下这是致命的。

### 用 jieba 的词性标注

jieba 把三者标成不同助词：`uj` = 的、`uv` = 地、`ud` = 得。
**关键是：只有作助词时它们才是独立 token。**

```
他高兴地接受了 → 他/r 高兴/b 地/uv 接受/v   ← 独立助词，可折叠
这片土地       → 这片/x 土地/n              ← 无独立助词，不可折叠
他得到了批准   → 得到/v                     ← 无独立助词，不可折叠
```

分词器天然解决了「实词里含有的/地/得」——那些字根本不是独立 token。

```ts
import * as jieba from '@isdk/nlp-jieba';
import { createJiebaParticleTagger } from '@isdk/zh-particles';

const tagger = createJiebaParticleTagger(jieba);
locateExcerpt(ex, text, { markdown: md, ignoreParticles: tagger });
// 高层入口更简单：matchExcerpt(ex, text, { ignoreParticles: true }) 自动装配 jieba
```

实测 **6/6 助词混用命中、11/11 实词误用拒绝**。

> ⚠️ **必须先 `addDefaultDict()`**，否则所有词性都是 `x`，判定完全失效。
> `createJiebaParticleTagger` 会在首次调用时自动帮你调一次。

### 三档策略

| 值 | 说明 | 依赖 |
|---|---|---|
| `false`（**默认**） | 不折叠。最安全，零误判 | 无 |
| `true` | 保守模式：实词保护表。零依赖但补不全 | 无 |
| `ParticleTagger` | 词性感知。**推荐** | WASM |

默认改成 `false` 是因为**误判代价高于漏判**：漏了只是少个命中，
错了是造了个假引用。

保守模式那张表是无底洞 ——
`大地 / 土地 / 地方 / 地址 / 得到 / 懂得 / 值得 / 获得 / 记得 / 觉得 / 显得 /
使得 / 目的地 / 根据地 / 殖民地 / 心地 / 见地 / 境地…` 手动枚举补不全。
能引入 jieba 就用 jieba。

折叠是 1→1 的，不改变长度，坐标映射不受影响。

### 打包注意

`@isdk/nlp-jieba` 的 nodejs 版是运行时 `fs.readFileSync(__dirname + '/jieba_bg.wasm')`
加载二进制 —— **.wasm 是资源文件，不是模块，esbuild 打不进 bundle**。
实测 bundle 后运行时报 `ENOENT: jieba_bg.wasm`。

所以必须 external（本工程 `tsup.config.ts` 已配）：

```ts
external: ['@isdk/nlp-jieba']
```

**`esbuild-plugin-wasm` 解决不了这个问题** —— 它处理的是
`import wasm from './x.wasm'` 这种 ESM import 语句，对 `readFileSync` 无能为力，
且只支持 esm 输出格式（依赖 top-level await）。

### 性能

`addDefaultDict()` 约 49ms（一次性），分词约 1.5μs/字符
（6000 字 ≈ 9ms）。配合 `createTextIndex` 缓存，只在建索引时付一次代价。
超长文本（默认 > 200_000 字符）会跳过判定，退回不折叠。

## 归一化是分阶段流水线，**顺序是设计的一部分**

```
1. foldWidth         NFKC 折叠 + 剔除零宽字符
2. normalizeNumbers  数字记法归一     ← 位置关键，见下
3. foldCase          大小写
4. foldPunctAndSpace 标点折叠 / 助词折叠 / 空白 → 占位符 / 跨文字删空格
```

### 数字归一必须排在「NFKC 之后、标点折叠之前」

千分位 `1,000` 里的 `,` 是纯排版符；顿号 `1、000` 里的 `、`
是列表分隔符。等到第 4 步，两者都已被折成 `,`，**无从区分**。

但它也**不能排在 NFKC 之前** —— 中文文档里千分位多是全角 `1，000`，
只有 NFKC 之后才变成 `,`。

```
1,000  (半角)  NFKC → 1,000   → 命中千分位  ✅
1，000 (全角)  NFKC → 1,000   → 命中千分位  ✅  ← 中文文档主流写法
1、000 (顿号)  NFKC → 1、000  → 不命中      ✅
```

这是「折叠」而非「替换表」思路的延续：**靠前置的通用折叠把变体收敛，
后续规则只需认一种形式**，不必穷举（穷举永远补不全）。

### 数字记法

| 形式 | 默认 | 理由 |
|---|---|---|
| `1,000` ≡ `1000` | **开** | 分隔符不携带信息，纯表示法 |
| `1，000`（全角） | **开** | 同上，NFKC 后归一 |
| `1_000` | 关 | `_` 更常见的身份是标识符一部分 |
| `一千` ≡ `1000` | 关 | **换了一套数词系统**，且 `三思而行` 里的「三」不是数词 |

千分位用严格模式（`分隔符 + 正好 3 位 + 后面不再跟数字`），
所以 `1,0000`、`12,34`、`第1,2条` 都不会被误处理。

### 中文数词：用 `cjk-number`，不自研

这一块**曾经自己写了 177 行解析器，实测下来是个错误**。换成 `cjk-number` 后：

| 输入 | 自研实现 | `cjk-number` |
|---|---|---|
| `两万` | ❌ | ✅ 20000 |
| `負一百零二` | ❌ | ✅ -102 |
| `一點二三` | ❌ | ✅ 1.23 |
| `一万二千三百四十五` | ❌ | ✅ 12345 |
| `二〇二三` / `壹仟` | ✅ | ✅ |

纯数词解析 **16/16**，且覆盖口语「两」、年份、负数、小数、连续进位。

```ts
import * as cjk from 'cjk-number';
import { createCjkNumberParser } from '@isdk/normalize-text';
locateExcerpt(ex, text, {
  cjkNumerals: true,
  cjkNumeralParser: createCjkNumberParser(cjk),  // 注入后端
});
```

> **`cjk-number` 是 ESM-only**（exports 只有 `import` 条件，`require` 会失败）。
> 高层入口已随包必装并自动装配（加载器带 ESM 入口回退，Node ≥ 20.19）；
> 低层入口仍按上面显式注入。

**诚实说明**：换库解决的是**纯数词解析的正确性**，但**「某个汉字在此处是否为数词」
的歧义依然存在**。整串调 `number.parse('三思而行')` 确实会抛错，看似提供了
"不是数词"的信号；但适配层为了拿到 `consumed`（归一化要用它维护坐标）
必须分段尝试，于是「三」又被单独解析出来，结果与自研一样是 `3思而行`。

这是**语言本身的固有歧义**，不是实现缺陷 —— 所以 `cjkNumerals` 默认仍是关闭的。

## 只想用其中一部分能力？装对应的子包

本包**只暴露自己的契约**（定位、预设、语言策略、T3/T4 适配）。
底下的能力已经拆成独立子包，**各自发布、各自有 README** ——
想单独用请直接装子包，不必引入整个匹配器：

| 能力 | 包 |
|---|---|
| 归一化 + 原文坐标映射 | `@isdk/normalize-text` |
| md 源码 ↔ 渲染后文本坐标 | `@isdk/md-flatten` |
| 近似区间定位（T3） | `@isdk/approx-text-match` |
| 两阶段语义定位（T4） | `@isdk/semantic-locate` |
| 脚本感知空白 | `@isdk/whitespace-semantics` |
| 标识符变体归一 | `@isdk/identifier-variants` |
| 中文否定检测 | `@isdk/zh-negation` |
| 的/地/得 判定 | `@isdk/zh-particles` |

```ts
import { normalizeWithMap, snapToGraphemeBoundary } from '@isdk/normalize-text';
import { unicodeScriptOf, canDropSpaceBetween } from '@isdk/whitespace-semantics';
import { detectNegation } from '@isdk/zh-negation';
import { createJiebaParticleTagger } from '@isdk/zh-particles';
import { createMdastFlattener } from '@isdk/md-flatten';
import { splitSegments } from '@isdk/semantic-locate';

import { createCjkNumberParser } from '@isdk/normalize-text';
import * as cjk from 'cjk-number';
// 解析后端需注入（本库不自带中文数词解析，见上文「多义词」）
createCjkNumberParser(cjk).parse('一百二十三', 0); // { value: '123', consumed: 5 }

detectNegation('他没来').negated; // true
detectNegation('非常').negated;   // false（实词，非否定）

const flat = createMdastFlattener(fromMarkdown).flatten(mdSource);
flat.text;    // 渲染后可见文本
flat.map[10]; // 第 10 个字符在 md 源码中的下标
```

> 语言策略（`detectLanguageProfile` / `languageProfileFor` / `tokenize`）
> 与 T3/T4 的适配工厂（`createBitapFallback` / `createDmpEsFallback` / `locateSemantic`）
> 是**本包自己实现**的，仍从 `excerpt-match` 导入。

> 完整模块分层、依赖图、坐标系说明见 **[ARCHITECTURE.md](./ARCHITECTURE.md)**。

## 一律先找成熟库，只在没有时才自己写

本库的边界很明确：**凡是标准库或成熟包能做的，一律不自己实现**。
自己写的代码只剩两类 —— 没有库提供「归一化后还能回切原文坐标」，
以及各层之间的编排与取舍（那是业务语义，不是算法）。

| 需求 | 用的库 | 说明 |
|---|---|---|
| 字形簇切分 | `Intl.Segmenter` (grapheme) | 内置，UAX #29 |
| 分词 | `Intl.Segmenter` (word) | 内置，依赖 ICU |
| 中文词性 / 助词判定 | `@isdk/nlp-jieba` | 可选，WASM |
| 模糊定位 | `diff-match-patch-es` | Bitap |
| Markdown 解析 | `mdast-util-*` | 带 `position.offset` |
| 分词器缓存 | `secondary-cache` | 二层：fixed + LRU |

### 分词器缓存：为什么是二层（`secondary-cache`）

`locale` 来自**用户输入**，若用无界 `Map`，长驻服务里 locale 变体会不断累积
（`zh-CN` / `zh-Hans-CN` / `zh-Hans-CN-u-co-pinyin` …）—— 内存泄漏入口。

但纯 LRU 也有代价：高频的内置 locale 可能被大量生僻 locale 挤掉，
然后反复重建 `Intl.Segmenter`（不便宜）。

二层结构正好对应两类键的不同性质：

| 层 | 放什么 | 淘汰 |
|---|---|---|
| **fixed** | 内置语言的 locale（`zh` / `en` / `ja` / `ko` / `th`…） | **永不** |
| LRU | 调用方传入的任意 locale | 会，超出上限淘汰 |

实测塞入 100 个用户 locale 后，5 个内置 locale 全部保留。

另外必须容错：`new Intl.Segmenter('xx-locale-0')` 会抛
`RangeError: Incorrect locale information provided`。
非法 locale 退化为默认分词器并照常缓存（避免每次重试构造）——
这个问题是补单元测试时发现的。

### 字形簇：为什么必须交给 `Intl.Segmenter`

手写「退到基字符」的逻辑只能处理代理对和组合符，
下面这些一个都处理不了，而且规则随 Unicode 版本演进：

```
👨‍👩‍👧‍👦  ZWJ 家庭     1 个簇（手写会切成 4 个人 + ZWJ）
🇨🇳      区域指示符对   1 个簇（手写会切成两半）
👍🏽      肤色修饰符     1 个簇（手写会把肤色切出去）
```

## 标识符拼写归一：**只拆不合**

`HelloWorld` / `hello_world` / `hello-world` / `hello world` 应是同一个标识符。
但方向很关键：

```
合并  Hello World → HelloWorld   普通的两个单词也被并掉了  ❌
拆分  HelloWorld  → Hello World  只在「本该有空格却没有」处插入  ✅
```

**为什么拆分更安全** —— 这里存在关键的不对称：

```
自然文本里不会出现两个词紧贴无空格（thecourt 不是合法英文）
  → 「无空格 + 驼峰」是标识符的强信号
而「有空格 + 驼峰」在标题、人名里到处都是（Hello World）
  → 据此删空格必然误伤
```

而且 `thecourt` 是小写接小写，触发不了拆分规则，天然安全。

```ts
{ splitCamelCase: true, normalizeIdentifierSeparators: true }
```

两者默认 `false`。

**只在标识符语境生效**（两侧都是 `[A-Za-z0-9]`）：

```
北京-上海  ←  北京上海    ❌ 拒绝   （汉字两侧不拆，否则两个地名被并成一个）
第3-5条    ←  第35条      ❌ 拒绝   （数字范围同理）
```

已知限制：`McDonald` → `Mc Donald`、`iPhone` → `i Phone` 会误拆。
但由于文档与摘录走同一套转换，**同一个词仍然匹配**；
只有两个不同的原文收敛成同一串时才会误判。

## `ignorePunctuation` 的三种写法

「忽略标点」其实是三个不同的问题，压成一个布尔位会互相打架，所以除了 `boolean` 还支持：

```ts
locateExcerpt(ex, text, { ignorePunctuation: true });                  // 折成占位符，删不删看两侧文字
locateExcerpt(ex, text, { ignorePunctuation: 'drop' });                // 占位符一律删：只留文字骨架
locateExcerpt(ex, text, { ignorePunctuation: { symbols: true } });     // 反引号、+ = ~ 也算标点
locateExcerpt(ex, text, { ignorePunctuation: { keep: [/\s+/] } });     // 只折标点，保留词边界
```

| 子决策 | 选项 | 默认 |
|---|---|---|
| 哪些字符算标点 | `symbols`（打开 `\p{S}`）、`extra`（点名追加） | `\p{P}` |
| 折叠后留不留占位符 | `'fold'` / `'drop'` | `'fold'` |
| 有没有例外 | `keep` 保护区 | 空（另有默认的省略表达保护，见下） |

**`'drop'` 是删到底**：占位符一律删除，**连拉丁词边界的空格一起丢**，只留文字骨架 ——
`ab, cd` 归一化后是 `abcd`，于是 `abcd` 与 `ab cd` 无法区分。这是有意的取舍：
查重 / 召回宁可多命中再靠 `score` 排序；但用于引用校验会制造假命中，**别用它做取证**。
想要「只删标点、留词边界」，组合 `keep` 即可：

```ts
{ ignorePunctuation: { mode: 'drop', keep: [/\s+/] } }  // 'hello, world' → 'hello world'
```

**省略表达默认受保护**：摘录里用户 / 系统写下的 `……`、`〔略〕` 是**结构性分隔符**，不是排版标点。
折叠它们会把 T2 分段锚点一并废掉 —— 开着「忽略标点」反而比关着更难命中，与开关意图相反。
确要一并折叠时显式写 `{ preserveEllipsis: false }`。

> 反引号 `` ` `` 属 `Sk`、`+ = ~` 属 `Sm`，都不在 `\p{P}` 里，默认**不**参与折叠：
> 代码与数学文本里它们载义。md 的 `**`、`` ` ``、`[](url)` 也不在这一层 ——
> 它们早在**摊平层**就被剥掉了。

## `punctFolded`：区分「严格命中」与「靠忽略标点才命中」

开启 `ignorePunctuation` 后，字面不同的摘录也能命中。但调用方往往
**只敢对严格命中直接引用**，其余要送人工复核 —— 所以需要区分这两类。

```ts
const r = locateExcerpt(ex, text, { markdown: md, ignorePunctuation: true });
if (r.kind === 'exact' || (r.kind === 'normalized' && !r.punctFolded)) {
  cite(r);               // 只有严格命中才直接引用
} else if (isHit(r)) {
  flagForHumanReview(r); // 跨过标点差异 → 人工复核
}
```

语义是「**跨越了差异**」，不是「折叠了标点」—— 后者在开启选项后会
把所有命中都标 `true`，调用方就无从区分了：

| 文档 | 摘录 | `punctFolded` |
|---|---|---|
| `本院认为，被告…。` | `本院认为，被告…。` | `false` —— 标点一致，`exact` 就能命中 |
| `本院认为，被告…。` | `本院认为。被告…，` | `true` —— 逗号与句号互换 |
| `本院认为，被告…。` | `本院认为被告…` | `true` —— 摘录完全没有标点 |

**宽度差异不算**：全半角、中英标点由 `ignoreWidth` 处理，属 T1 常规归一，
不需要人工复核（`本院认为,被告…` ↔ `本院认为，被告…` 为 `false`）。

判定方式是：两侧各自按 `ignorePunctuation: false` 重新归一化再比较 ——
文档侧是「命中片段 **+ 紧邻的边缘标点**」，摘录侧保持原样；
不同即说明是忽略标点才匹配上的。
md 模式下比较的是**摊平后**的文本，所以 `**`、`[](url)` 这类语法标记不会被算进差异。

两侧是**不对称**的：

- **文档侧要补边缘标点**。归一化把首尾标点当可选分隔符丢弃，命中区间常常不含
  末尾句号；不补的话，「两边其实都有句号」会被误报成差异，而「文档是冒号、
  摘录是句号」这种**真实差异**又因为恰好落在边上而被漏报 —— 补上之后，
  有就有、是什么就是什么。
- **摘录侧保持原样**。它的标点有没有、是什么，本身就是要比对的内容，不能替它补。

补齐有两条止步规则，都源于「块边界」：

- **止于换行**（严格视图）：换行是块边界，下一段的内容不属于本次命中；
- **止于块边界**（无分隔符的跨块视图）：块间分隔符被剥掉后相邻块直接贴在一起，
  单靠上一条挡不住 —— 扩展被夹回命中块的范围内，不会把下一块开头的标点
  误当成命中区域的收尾。

`exact` 恒为 `false`（字面完全一致，不可能跨差异）。

## 多义词：为什么默认保守，以及真正的风险在哪

以 `未来` 为例 —— 它既可能是时间名词（`他来自未来`），
也可能是「没有来」的口语省略（`他未来`）。

### 先厘清：多义词本身不是本库的风险

文档与摘录走**同一套转换**，`未来` 归一后还是 `未来`，两边一致。
本库的契约是**定位**而非**判义**：给定相同的字符串，就该指向相同的位置。

真正的风险是**「异文收敛」** —— 两个**不同**的原文被归一化成同一串：

```
一一列举  →  11列举   ┐
十一列举  →  11列举   ┘ 不同含义收敛成同一串 ← 这才是假命中的来源
```

多义词没有这个现象。所以 `cjkNumerals` 默认关闭的理由在这里，
而多义词不需要在归一化层处理。

### 无法消歧时，选择保守

`未来` 作时间名词的频率远高于「没有来」的口语省略。两种取向的后果：

| 取向 | `他来自未来` vs `他来自过去` | `他来到了` vs `他未来` |
|---|---|---|
| **保守（默认）** | 不拒绝 ✅ | 不拒绝 ❌ 漏判 |
| 激进 | **错误拒绝** ❌ | 拒绝 ✅ |

**误拒的代价更高**：漏判只是少一道守卫，误拒是让合法摘录彻底找不到出处。
所以默认把这类词按**非否定**处理。

### 按领域覆盖

多义词究竟取哪个义，取决于上下文 —— 那是词义消歧（WSD），超出本库范围。
本库的做法是**保守默认 + 留出覆盖口子**，而不是假装能自动判断：

```ts
locateExcerpt(ex, text, {
  negationLexicon: {
    negations: ['未来'],        // 口语稿：把「未来」也当否定
    nonNegations: ['无限制'],   // 产品名/术语：永远不算否定
  },
});
```

`nonNegations` 优先级最高，且能解除内置白名单的保护 ——
否则 `未来` 这类内置非否定词永远覆盖不掉。

### 实现：为什么是「汉字区间内顺序扫描」

否定判定踩过三个坑，每个都对应一种实现选择：

| 做法 | 问题 |
|---|---|
| 整词匹配分词结果 | `无限制套餐` 被切成 `["无","限制","套餐"]`，白名单「无限制」失效 |
| 全局最长匹配 | `不得不`（双否定 → 肯定）只数出一个「不」，双重否定失效 |
| **汉字区间内顺序扫描** | ✅ 合并相邻汉字 token，白名单优先 + 否定词最长匹配 |

## 混合文字的空格：能删才删

中日文夹英文时，空格该不该忽略？**判据：删掉它会不会造成边界歧义。**

这个判据可以客观测量 —— 比较「原文」与「删掉全部空格后」的分词结果：

```
汉字   本院认为... → 本院|认为|被告|违约     一致  ✅ 空格不载义
假名   機械学習... → 機械|学習|の|応用       一致  ✅ 空格不载义
韩文   아버지가 방에  → 아버지가|방에|들어가신다
       아버지가방에  → 아버지가방에들어가신다   ★不同 ❌ 空格载义
泰文   สัญญาผิด... → สัญญา|ผิด|เงื่อนไข      一致（词层面）
拉丁   The court → The|court|held
       Thecourt  → Thecourtheld               ★不同 ❌ 空格载义
```

### 三种角色

| 角色 | 含义 | 文字 | 删除后果 |
|---|---|---|---|
| `ignorable` | 纯排版产物 | 汉字、假名 | 无影响 |
| `wordDelimiter` | 词分隔符 | 韩文、拉丁、数字 | **词边界歧义** |
| `boundary` | 句子/短语边界（≈标点） | 泰文 | **句子边界丢失** |

### 韩文与泰文：结论相同，理由不同

**韩文** —— 助词依附于前词，删空格造成归属歧义（韩语正字法标准例句）：

```
아버지가 방에 들어가신다  = 父亲走进房间
아버지 가방에 들어가신다  = 钻进父亲的包里
        ↓ 删空格后是同一串
```

**泰文** —— 词连写、空格分**句子/短语**，删掉后词仍能切开，
但句子边界消失，**等价于英文删掉句号**。同样属于改变意义，所以同样保留。

### 跨文字边界一律可删

脚本之间的空白是排版产物，与本族文字内的空格性质不同：

```
使用 TensorFlow 框架  ≡  使用TensorFlow框架  ✅
共 100 人参加         ≡  共100人参加         ✅
สัญญา TensorFlow     ≡  สัญญาTensorFlow     ✅
```

但**同一文字内部**的空格按上表处理，绝不删除：

```
使用 TensorFlow 框架  ←  使用 Tensor Flow 框架  ❌ 拒绝
共 1 000 人           ←  共 1000 人             ❌ 拒绝
```

数字单独归为一类（`wordDelimiter`）：跨文字时可删（`共 100`），
数字之间不可删（`1 000 ≠ 1000`）。

## 语言

语言策略收敛在 `profiles.ts`，核心算法保持语言无关。语言只影响：

1. CJK 相邻处是否删除空白（中文排版换行不产生空格，英文必须保留）
2. T3 / T4 用字级还是词级切词
3. 用哪个 locale 初始化 `Intl.Segmenter`

```ts
profileFor('zh').granularity;  // 'char'
profileFor('en').granularity;  // 'word'
detectProfile('本院认为被告构成根本违约').id; // 'cjk'
```

- **中文走字级**：短摘录（十几字）做词级模糊匹配，召回反而不如字级稳定
- **英文必须词级**：字级会让 4 字符种子满篇都是，定位退化
- 分词用内置的 `Intl.Segmenter`（依赖 ICU 词典），不需要 nodejieba 这类原生模块

## T3 / T4：接入外部能力

### T3 模糊匹配

推荐用 `diff-match-patch-es`：

```ts
import * as dmpEs from 'diff-match-patch-es';
const fuzzy = createDmpEsFallback(dmpEs);
locateExcerpt(ex, text, { markdown: md, fallbacks: [fuzzy] });
// 高层入口（matchExcerpt）不传 fallbacks 时已默认注入这个匹配器
```

既有代码可继续用 `createDmpFallback(new diff_match_patch())`，但该包自 2020-05
后未再发版，已标记 `@deprecated`。

#### 为什么不用 jsdiff / @lowlighter/diff

选型的关键不是「谁活跃」，而是**有没有 Bitap 模糊定位**。我们要的不是
「算两个字符串的差异」，而是「在 600KB 文本里模糊定位摘录的位置」——
这是 dmp 独有的 `match_main`，jsdiff 没有对应能力（它只有 `diffChars` 等全量比对），
真要用它，seed-and-extend 的定位部分得全部自己写。

| 候选 | 维护 | 模糊定位 | 判断 |
|---|---|---|---|
| `diff-match-patch-es` | ✅ 活跃 | ✅ | **推荐** |
| `diff-match-patch` | ❌ 2020 停更 | ✅ | 兼容保留 |
| `diff`（jsdiff） | ✅ 活跃 | ❌ | 能力不匹配 |
| `@lowlighter/diff` | ⚠️ 周下载 3 | ❌ | 排除 |

> 两个注意点：
> 1. `diff-match-patch-es` 是**纯 ESM**（`exports` 只暴露 `.mjs`），
>    构建链含 CJS 环节时请先确认能否 `require`。
> 2. 它对 `matchThreshold` 比原版敏感 —— 实测同一摘录在 0.4 下返回 -1、0.5 下正常。
>    因此 adapter 默认**不传** options，直接用库的默认值。

三个 adapter 共用 `createBitapFallback(match, diff)`，换后端只需提供两个函数。

### T4 语义召回（`locateSemantic` 是实现层，不是平行入口）

T4 有**两种接法**，可以与 T3 叠加使用：

1. **作为 fallback 之一**：自己实现 `FallbackMatcher`（`kind: 'semantic'`）放进
   `fallbacks` 数组，与 T3 按序尝试 —— 数组里的匹配器本来就不限层；
2. **两阶段召回**：`retriever`（召回）+ `aligner`（段内对齐），异步，坐标更准。
   这是下面 `matchExcerpt` 内置的通道。

两阶段的设计理由 —— 不让模型直接吐字符下标：

1. LLM / embedding 返回的下标在长文里经常漂 —— token ≠ 字符
2. 召回只需回答「大概是这一段」，精确定位是确定性问题
3. 召回器可以随便换，坐标逻辑一行不动

`locateSemantic` 就是这条通道的坐标适配层（把召回结果换算回源码坐标），
普通调用方**不需要直接调它** —— 走 `matchExcerpt` 即可；只有自建召回流程时才用：

```ts
const r = await locateSemantic(idx, '合同可以通过要约与承诺来订立', retriever, {
  aligner: fuzzy,
  minRecallScore: 0.5,
  minAlignScore: 0.5,
});
```

不传 `aligner` 会退化为高亮整个段落并降分（`via: 'semantic:segment'`）。

### 自定义 fallback

```ts
const myFallback: FallbackMatcher = {
  name: 'my-model',
  kind: 'semantic',
  find(needle, hay, ctx) {
    // 返回归一化空间的 [{ start, end, score }]
  },
};
```

契约只到「归一化空间的 `[start, end)`」，坐标回切由 locator 统一负责 ——
所以换成任何库都不用碰坐标逻辑。

## 高层入口：`matchExcerpt` —— 一步到位的结论

只要**一条调用覆盖 T0–T4、返回「结论 + 可引用原文 + 完整元数据」**时用它：

```ts
import { matchExcerpt, createExcerptMatcher } from '@isdk/excerpt-match';

// 零配置：md 摊平（mdast+GFM）与 T3 模糊层（diff-match-patch-es）已内置
const r = await matchExcerpt(excerpt, mdSource);
if (r.found) cite(r.source);       // r.source 就是 md 源码片段

// 需要语义召回（T4）时才配置 retriever —— 本包不自带召回实现
const r2 = await matchExcerpt(excerpt, mdSource, {
  retriever,
  onHit: (ex, r) => track('hit', r),   // 可选：命中即回调
  onMiss: (ex, r) => track('miss', ex), // 可选：未命中回调，未配置就是静默
});

// 同一篇文档对多条：建一次索引，别每条重建
const m = await createExcerptMatcher(mdSource, { retriever });
for (const it of items) it.ok = (await m.match(it.excerpt)).found;
```

| 字段 | 含义 |
|---|---|
| `found` | 是否命中 —— 「是否出自这篇文本」的结论 |
| `source` | **命中的 md 源码片段** = `text.slice(index, index + length)`，含语法标记 |
| `text` | 剥掉语法标记的可见文本，供展示 |
| `index` / `length` / `line` | 源码坐标与行号，可直接高亮 |
| `kind` / `score` / `occurrences` / `punctFolded` / `crossesBlocks` | 继承自 `ExcerptMatch` 的完整定位元数据 —— 歧义与严格性判定不用再查第二次 |

- **内置默认，显式传入永远覆盖**：

  | 选项 | 不传时 | 收紧方式 |
  |---|---|---|
  | `markdown` | 内置 mdast + GFM 摊平器 | 传自己的摊平器；`markdown: null` 强制纯文本 |
  | `fallbacks` | 内置 `diff-match-patch-es` 模糊层 | `preset: 'strict'` 或显式 `fallbacks: []` |
  | `aligner` | 与 `fallbacks` 同源（T4 段内对齐） | 传自定义对齐器 |
  | `cjkNumeralParser` | 开了 `cjkNumerals` 自动装配 `cjk-number` | 传 `createCjkNumberParser(cjk)` |
  | `ignoreParticles: true` | 自动升级为内置 jieba 词性判定 | 传自己的 `ParticleTagger` |

  唯独 `retriever` 没有默认 —— 语义召回需要 embedding / BM25 这类外部服务，
  不传就绝不碰语义层。
- **T3 / T4 可叠加**：`fallbacks`（T3 与任意自定义匹配器）在同步阶段按序尝试；
  未命中且给了 `retriever` 才动用语义召回。
- **异步**：统一 `await`，与是否配置 T4 解耦 —— 调用方式不随档位变化。
  （内置默认按需惰性加载，`createExcerptMatcher` 因此是 async。）
- `minScore`（默认取 `minFallbackScore`，即 0.75）只约束 T3/T4 —— T0–T2 恒为 1。
  引用校验 / 取证建议显式抬高（如 `0.9`）；查重 / 召回维持默认即可。
- 未命中**默认静默**；需要埋点就配 `onMiss`。

从手搓的 `toLowerCase + includes` 迁过来，额外补上的是：
md 摊平、跨块复制、跨标点差异、省略号多写法（且**按原文顺序链式命中**，
不像「逐段 exists」那样把散落全篇的片段也算通过），以及 T4 接住的标题词注入与跨小节归纳。

## 入口怎么选

| API | 同步 | 层级 | 返回 | 适用 |
|---|---|---|---|---|
| `matchExcerpt` | 异步 | **T0–T4** | 结论 + 源码片段 + 完整元数据 | 一步到位：校验、引用、批量核查 |
| `createExcerptMatcher` / `.match()` | 异步 | **T0–T4** | 同上 | 同一构造配置复用于多条摘录（索引只建一次） |
| `locateExcerpt` | 同步 | T0–T3 | `ExcerptMatch` 坐标元数据 | 只要坐标，自己编排回调 |
| `createTextIndex` / `index.locate` | 同步 | T0–T3 | 同上 | 同一篇文本查多条，复用索引 |
| `locateSemantic` | 异步 | T4 | `ExcerptMatch` | 自建召回流程时的坐标适配层 |

一句话：**要结论用 `matchExcerpt`，要坐标用 `locateExcerpt`**；
`locateSemantic` 是实现层，普通调用方不必碰。

## 性能

整篇归一化（含 md 摊平）是 O(n) 的重活。逐条摘录调用 `locateExcerpt`
会对同一篇文本重复整篇处理。

```ts
const idx = createTextIndex(text, { markdown: md }); // 归一化一次
for (const it of items) idx.locate(it.excerpt);      // 之后每次只做比对
```

实测：

| 场景 | 单次 | 复用索引后 |
|---|---|---|
| 600KB 纯文本 | ~200ms | ~7ms |
| 12KB markdown | ~60ms | ~4ms |

## 模块结构

```
src/types.ts        统一返回契约 + 可插拔接口
src/normalize.ts    归一化 + 原文下标映射（全库唯一"魔法"，无库可替）
src/profiles.ts     语言策略：空白处理、分词粒度
src/markdown.ts     md 源码 → 渲染后可见文本 + 精确源码映射
src/locator.ts      T0/T1/T2 确定性分层 + fallback 编排 + 坐标回切
src/fuzzyMatch.ts   T3 适配：diff-match-patch 接进本包坐标系
src/semanticMatch.ts T4 适配：语义召回接进本包坐标系
src/excerptMatcher.ts 高层入口：T0–T4 编排，结论 + 原文 + 元数据
```

自己写的只有三件事，其余全部交给现成库：

1. 归一化 + 下标映射（无库提供「归一化后还能回切原文坐标」）
2. 归一化空间 → 源码坐标的回切（无库知道我们的坐标系）
3. 分层编排与门限（业务语义）

## 开发

```bash
npm test          # vitest run，300+ 项
npm run typecheck # tsc --noEmit
npm run build     # tsup，产出 ESM + CJS + .d.ts
```

测试覆盖：分层用例、坐标还原属性测试（随机切片往返验证）、
跨块相邻性与首个匹配、转义 / 实体精确性、归一化幂等。
