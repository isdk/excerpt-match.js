# 架构

> 面向 review 者。读完这份文档，你应该能独立改动任意模块而不需要通读全部源码。

## 一、一句话概括

**在一个"归一化后的文本空间"里做字符串查找，再把找到的区间精确换算回源码坐标。**

整个库的复杂度几乎都集中在两件事：

1. **归一化时如何保留坐标**（没有库做这个，必须自己写）
2. **命中后如何把区间回切成源码里的精确片段**

其余都是这两件事的编排与取舍。

## 二、分层

包按依赖分层，**上层可以依赖下层，反过来不行**（已验证无循环依赖）：

```
┌──────────────────────────────────────────────────────────┐
│ L4  主包（编排）                                          │
│     @isdk/excerpt-match                                  │
│       locator.ts      核心编排，唯一的主流程              │
│       presets.ts      三档预设                            │
│       languageProfiles.ts  语言策略 + 分词器缓存           │
│       fuzzyMatch.ts / semanticMatch.ts  T3/T4 坐标适配    │
├──────────────────────────────────────────────────────────┤
│ L3  语义 / 近似                                           │
│     @isdk/semantic-locate      两阶段定位（T4）           │
│     @isdk/approx-text-match    近似区间定位（T3）         │
├──────────────────────────────────────────────────────────┤
│ L2  坐标映射（本库最硬的两块）                             │
│     @isdk/normalize-text      归一化 + 坐标映射           │
│     @isdk/md-flatten          md 源码 ↔ 渲染文本          │
├──────────────────────────────────────────────────────────┤
│ L1  无依赖的叶子                                          │
│     @isdk/whitespace-semantics        脚本感知空白              │
│     @isdk/identifier-variants   标识符变体                │
│     @isdk/zh-particles          的/地/得                  │
│     @isdk/zh-negation           中文否定检测              │
└──────────────────────────────────────────────────────────┘
```

L1 四个包**完全零依赖**，这是实际能独立复用的部分。

## 三、包依赖图

```
                    @isdk/excerpt-match  (主包)
                            │
        ┌───────────┬───────┴────┬──────────────┐
        ▼           ▼            ▼              ▼
  semantic-locate  approx-   md-flatten   normalize-text
        │          text-match     │              │
        │              │          │         ┌────┼────┬────┐
        ▼              │          ▼         ▼    ▼    ▼    ▼
   zh-negation         │    normalize-text  script- identifier- zh-particles
                       │                    spacing variants
                       └────────────────────────┘
```

要点：

- `md-flatten` 依赖 `normalize-text`（它要产出 `NormalizedText`）
- `semantic-locate` 依赖 `zh-negation`（极性守卫）
- `approx-text-match` **不依赖任何子包**（只做纯字符串区间）
- L1 四个包互不依赖，可单独安装

## 四、主流程（`locator.ts` / `locateIn`）

```
摘录 + 页面
    │
    ├─ buildHay：页面 → 归一化空间（md 模式先摊平）
    │      ├── strict 视图（块间有分隔符）
    │      └── joined 视图（块间无分隔符，供跨块摘录）
    │
    ├─ T0 精确        raw.indexOf(excerpt)             → kind: exact
    ├─ T1 归一化      norm.text.indexOf(needle)        → kind: normalized
    ├─ T2 分段锚点    省略号切成多段链式定位              → kind: segmented
    │      └── 两个视图都试，取**最早**的命中（位置 > 强度）
    │
    ├─ T3 模糊        外部 matcher（dmp Bitap）          → kind: fuzzy
    ├─ T4 语义        外部 embedding 召回 + 段内对齐      → kind: semantic
    │      └── 极性守卫在**候选过滤**阶段，不是命中后
    │
    └─ spanFromNormalized：归一化区间 → 源码精确 span
           ├── map[start] / mapEnd[end-1]
           ├── expandMarkers：补齐 ** 等行内标记
           └── snapToGraphemeBoundary：对齐字形簇
```

## 五、坐标系（改动前必须理解）

**四种坐标系混用是最容易出错的地方**：

| 坐标系 | 谁在用 | 换算 |
|---|---|---|
| ① md 源码 | `ExcerptMatch.index/length`（**对外契约**） | — |
| ② 摊平后可见文本 | `FlatResult.text` | `flat.map[i]` → ① |
| ③ 归一化文本 | `NormalizedText.text` | `map[i]` → ①，`back[i]` → ② |
| ④ 无分隔符视图 | 跨块匹配 | 由 ②③ 派生（过滤数组） |

关键不变量：

```
src.slice(map[i], mapEnd[i])  归一化后  ===  text[i]
```

- `mapEnd` **不能**由 `map[i+1]` 推算 —— 转义 `\*`、实体 `&amp;` 让一个可见字符横跨多个源码字符
- `back` 必须**跨阶段复合** —— 每个阶段只知道"指向本阶段输入"，直接写 `at` 会丢失前面阶段的长度变化

## 六、归一化流水线（`normalize.ts`）

四个显式阶段，**顺序是契约，不能调整**：

```
1. foldWidth          NFKC + 剔零宽字符
2. normalizeNumbers   数字记法          ← 必须在 1 之后、4 之前
3. foldCase           大小写
4. foldPunctAndSpace  标点 / 助词 / 空白
```

为什么数字必须在 2（详细推导见 README "数字记法"章节）：

- **在 NFKC 之后**：全角 `1，000` 要能匹配千分位，NFKC 前是 `，` 不是 `,`
- **在标点折叠之前**：顿号 `、` 不被 NFKC 折叠，放在前面可区分 `1,000`（千分位）与 `1、000`（列表）

## 七、想单独复用某部分？

每个子包都可独立安装，各自有 README：

```ts
import { normalizeWithMap } from '@isdk/normalize-text';   // 高亮/diff 都要它
import { createMdastFlattener } from '@isdk/md-flatten';   // 评论锚定
import { detectNegation } from '@isdk/zh-negation';        // 情感分析
import { createCachedFlattener } from '@isdk/md-flatten';  // 摊平缓存
```

判断标准：**只有"没人做过 + 有普适价值"的才值得独立**。
中文数词、分词、Bitap、字形簇、md 解析都有现成库，一律用别人的。

## 八、改动指南

| 想改什么 | 动哪个包 | 注意 |
|---|---|---|
| 加一种归一化规则 | `normalize-text` | 必须同步 `map`/`mapEnd`/`back` 三者 |
| 加一种语言 | 主包 `languageProfiles.ts` | 先按"删空格是否改分词"测一遍再归类 |
| 加一档 preset | 主包 `presets.ts` | 显式项永远覆盖预设，别反过来 |
| 加一层匹配（T 层） | 主包 `types.ts` 的 `MatchKind` + `locator` | 记得给 `strength()` 排序 |
| 换模糊匹配库 | `approx-text-match` 的 `adapters.ts` | 只需两个函数：`match` 与 `diff` |
| 改坐标回切 | `normalize-text` / `md-flatten` | `mapEnd` 与字形簇对齐都不能漏 |
| 加摊平缓存 | `md-flatten` 的 `cachedFlattener.ts` | key 优先 docId；注意 id 相同 = 内容相同 |

**跨包改动**：加一条标点等价只动 `normalize-text`，不外溢。
真正需要协调的只有"新增语言"（同时动 `languageProfiles` 与 `whitespace-semantics`）。

## 九、包划分（已拆）

早期这里写着"为什么没有拆成多个包"，后来拆了 —— 判据是
**"这件事有没有现成库；没有的话，它有没有普适价值"**。

| 包 | 职责 | 层 |
|---|---|---|
| `@isdk/excerpt-match` | 主包：分层定位与编排 + 坐标系统一 | T0–T4 |
| `@isdk/normalize-text` | 归一化 + 保留原文坐标映射 | T1 |
| `@isdk/md-flatten` | md 源码 ↔ 渲染后文本双向坐标映射 | T0/T1 |
| `@isdk/approx-text-match` | 近似子串定位（连续区间 + 相似度） | T3 |
| `@isdk/semantic-locate` | 两阶段语义定位：召回 → 段内对齐 | T4 |
| `@isdk/whitespace-semantics` | 脚本感知空白（韩文/泰文空格不能删） | T1 |
| `@isdk/identifier-variants` | `TensorFlow` ≡ `tensor_flow` | T1 |
| `@isdk/zh-negation` | 中文否定检测（词边界感知） | 守卫 |
| `@isdk/zh-particles` | 的/地/得：助词 vs 实词 | T1 |

**没有自己做的**：中文数词（`cjk-number`）、分词（`Intl.Segmenter` / jieba）、
Bitap（`diff-match-patch-es`）、字形簇（`Intl.Segmenter`）、md 解析（`mdast-util-*`）、
缓存（`secondary-cache`）。

### 数字记法为什么没独立成包

它在流水线里**位置敏感**：必须在 NFKC 之后、标点折叠之前。
独立出去容易放错位置 —— 有些东西耦合的不是代码，是**执行顺序**。

## 十、三档预设

25 个配置项多数是按场景决定的，故收敛成 `preset`：

| | `strict` | `default` | `loose` |
|---|---|---|---|
| 场景 | 引用校验 / 取证 | 高亮 / 锚定 | 查重 / 召回 |
| `ignorePunctuation` | false | false | **true** |
| `allowSegmented` | **false** | true | true |
| `allowCrossBlock` | **false** | true | true |
| `checkPolarity` | true | true | true |
| `cjkNumerals` | false | false | false |
| `ignoreParticles` | false | false | false |

**显式项永远覆盖预设**。最后两行三档一致是刻意的安全底线：
`cjkNumerals` 会让「一一」与「十一」收敛成同一串（假命中来源）；
`ignoreParticles` 面对的是错字而非语义等价。

## 十一、性能与缓存

### 瓶颈是摊平，不是归一化（实测）

800 段 md（约 6 万字符）：

```
mdast 摊平  298.6ms   ← 88%
归一化       41.7ms   ← 12%
```

所以优化该围着摊平做。

### 三层缓存

| 层 | 缓存什么 | 实现 |
|---|---|---|
| 分词器 | `Intl.Segmenter` 实例 | `secondary-cache` 二层（内置 locale 走 fixed 不淘汰） |
| 摊平结果 | `FlatResult` | `@isdk/md-flatten` 的 `createCachedFlattener` |
| 归一化视图 | `strict` + 无分隔符视图 | `TextIndex` 实例内惰性构建 |

**摊平缓存为什么要单独一层**：`TextIndex` 的缓存是**实例级**的，
同一份文档被两个 index 持有就要解析两遍。而摊平只依赖 flattener、
**不依赖 MatchOptions** —— 换选项时重建是纯浪费。

### 复用收益

| 用法 | 800 段单次耗时 |
|---|---|
| 复用 `TextIndex` | 1.96ms |
| 每次重建 | 165.5ms |

### 缓存 key：优先 docId，回退全文

```ts
const md = createCachedFlattener(base, {
  max: 32,
  docIdOf: (src) => /^id:\s*(\S+)/m.exec(src)?.[1],
});
md.flattenById(doc, 'doc-42');  // 推荐
```

全文当 key 的问题是**内存**（大文档等于存两份）与**相等性**
（无法表达"同一文档的两个版本"）。但注意：**docId 相同就意味着内容相同** ——
若同一 id 下内容会变（编辑器实时草稿），请让 `docIdOf` 返回 `undefined` 走全文。

id 键加了 `\u0000id:` 前缀，避免与全文键碰撞（某文档内容恰好等于另一个的 id）。


## 十二、测试组织

| 层级 | 命令 | 输出 |
|---|---|---|
| 全部 | `pnpm test` | **一次运行 + 一行汇总** |
| 单包 | `pnpm --filter @isdk/zh-negation test` | 只看该包 |

### 为什么用 `vitest.workspace.ts` 而不是 `pnpm -r run test`

后者每个包各跑一次，输出是 9 段独立的 `Test Files / Tests`，
得自己加起来才知道总数、才知道有没有全绿。workspace 模式把它们聚合成一次：

```
 Test Files  19 passed (19)
      Tests  253 passed (253)
```

一眼就能看出总数与成败。

### 各包自带 devDependencies

测试用到的外部包（mdast 系列、`diff-match-patch`、jieba、`cjk-number`）
声明在**使用它的那个包**里，版本与根对齐（避免 pnpm 装两份）。
子包将来独立出去，测试照样能跑。
