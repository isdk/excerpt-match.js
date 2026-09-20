# 包划分

> 原则：**已有成熟库的一律用库**；只有**没人做 + 有普适价值**的才独立成包。
>
> 命名空间统一用 `@isdk/`。

## 一、先厘清一件事：本库的 T3 不是「拼写检查」

你说 T3 属于拼写检查和纠错 —— **底层算法确实是同一族（近似字符串匹配）**，
但**需求形状不同**，这点直接决定要不要自己抽象：

| | 拼写检查 / 模糊搜索 | **本库 T3** |
|---|---|---|
| 输入 | 一个词 / 短查询 | 一段摘录 |
| 输出 | **候选集中最接近的项** | **长文本中的连续区间** + 相似度 |
| 典型库 | SymSpell / Fuse / fuzzysort | dmp `match_main` |

实测对比（页面 29 字，摘录漏了「的」「已经」两个词）：

```
fuzzysort : indexes = [0,1,2,3, 5,6,7,8,9, 12,...,17]   ← 分散的匹配字符
            连续? false
Fuse.js   : matches = [[0,3],[5,9],[12,17]]              ← 分散片段
本库 T3   : { index: 0, length: 18, score: 0.909 }       ← 连续区间 ✅
```

**关键差异**：模糊搜索库回答"哪些字符匹配上了"，本库要的是"命中哪一段"。
前者推不出后者 —— 前者跳过的不匹配字符（上例的标点位 4/10/11）在后者里
**必须被包含在区间内**，否则高亮会缺字。

所以：**用 dmp 的 Bitap 做定位是对的，不该换成拼写检查库**。
但「给定一个模式，在长文本中找出**连续区间 + 相似度**」这个需求，
确实没有专门的库 —— 这就是 `@isdk/approx-text-match` 的存在理由。

## 二、完整包清单

### 已抽出（可独立使用）

| 包 | 职责 | 依赖 | 状态 |
|---|---|---|---|
| `@isdk/whitespace-semantics` | 脚本感知空白：两字符间的空白是排版产物还是内容 | 无 | ✅ 已抽出 |
| `@isdk/identifier-variants` | 标识符变体归一：`TensorFlow`/`tensor_flow`/`tensor-flow` → 同一形式 | 无 | ✅ 已抽出 |
| `@isdk/zh-particles` | 的/地/得 词性判定：区分助词与实词（大地/得到/详细地址） | 分词器（注入） | ✅ 已抽出 |
| `@isdk/normalize-text` | 归一化 + **坐标映射**（含 `NormalizedText` 类型） | `whitespace-semantics` `zh-particles` `identifier-variants`、可选 `cjk-number` | ✅ 已抽出 |
| `@isdk/md-flatten` | md 源码 ↔ 渲染后文本的**双向坐标映射** | `normalize-text`、可选 mdast | ✅ 已抽出 |
| `@isdk/approx-text-match` | 近似子串定位：**连续区间 + 相似度** | 可选 dmp-es | ✅ 已抽出 |
| `@isdk/semantic-locate` | 两阶段语义定位：外部召回候选段 → 段内精确对齐 | `@isdk/zh-negation` | ✅ 已抽出 |
| `@isdk/excerpt-match` | **主包**：分层定位与编排（T0–T4）+ 坐标系统一 | 以上全部 | ✅ 已移入 `packages/` |

### 待抽出（本库自研、有普适价值）

| 包 | 职责 | 对应 T 层 | 依赖 | 价值 |
|---|---|---|---|---|
| `@isdk/zh-negation` | 词边界感知的中文否定检测 | 守卫 | `Intl.Segmenter` | 中 —— 情感分析/法务可用 |

> 所有候选包均已抽出。

> 数字记法（千分位 + 中文数词）**没有独立成包**：它在流水线里位置敏感
> （必须在 NFKC 之后、标点折叠之前），独立出去容易放错位置。
> 现在随 `@isdk/normalize-text` 发布。

### 明确**不**自己做的

| 能力 | 用谁 | 理由 |
|---|---|---|
| 中文数词 | `cjk-number` | 实测 16/16，自研 177 行已被删 |
| 分词 / 词性 | `Intl.Segmenter` / `@isdk/nlp-jieba` | 内置优先，重场景用 jieba |
| 模糊定位算法 | `diff-match-patch-es` | Bitap 唯一成熟实现 |
| 字形簇 | `Intl.Segmenter` | 随 Unicode 演进，手写补不全 |
| md 解析 | `mdast-util-*` | 每节点自带 offset |
| 语义向量 | 外部 embedding | 不该自己做 |
| 缓存 | `secondary-cache` | 二层结构匹配需求 |

## 三、T3/T4 的抽法

### T3 → `@isdk/approx-text-match`

抽的核心不是"调 dmp"，而是这两件 dmp 不管的事：

1. **seed-and-extend**：摘录里挑"在页面中出现次数最少"的种子 → Bitap 定位 → 双向扩展。
   Bitap 对长 pattern 效果差，直接扔整段进去不稳。
2. **区间边界确定**：dmp 的 `match_main` **只返回起始位置，不给长度**。
   本库用 diff 精修出结束位置，并按字形簇对齐。

外部契约：

```ts
interface ApproxMatch {
  start: number;
  end: number;      // 连续区间，含中间的不匹配字符
  score: number;    // 0~1
}
```

### T4 → `@isdk/semantic-locate`

T4 的真正价值不是"算向量"（那不该自己做），而是**两阶段定位这个模式**：

```
外部召回（embedding / BM25）→ 只知道"大概是这一段"
        ↓
段内再对齐 → 精确到字符下标
```

**为什么不让模型直接吐字符下标**：LLM/embedding 返回的下标在长文里经常漂
（token ≠ 字符）。召回只需回答"哪一段"，精确定位是确定性问题。

可提取的部分：
- `splitSegments(text, maxLen)` —— 按语义边界切段（薄但普适）
- 两阶段编排 + 极性守卫 + 降级策略（不传 aligner 时高亮整段并降分）

## 四、关于 `NormalizedText` 的归属

你的判断对：**它是类型不是函数，且是为坐标映射才开的，就该下沉到
`@isdk/normalize-text`**。

```ts
// @isdk/normalize-text
export interface NormalizedText {
  text: string;
  map: number[];      // 归一化下标 → 源码起始下标
  mapEnd?: number[];  // 不可由 map[i+1] 推算（转义/实体）
  back?: number[];    // → 上一层输入下标，跨阶段复合
}
```

命名用 `normalize-text`，`with-map` 是特性不是主体 —— 已按此调整。

## 五、关于「改一条规则要跨包发版」

**我上轮这个理由站不住，已撤回。**

规则在哪个包里就改哪个包 —— 加一条标点等价只动 `normalize-text`。
真正需要协调的只有两类：

1. **阶段顺序**（数字必须在 NFKC 之后、标点之前）—— 编排在 `normalize-text` 内部，不外溢
2. **新增语言** —— 需同时动 `languageProfiles` 与 `whitespace-semantics`

日常改一条归一化规则，不需要跨包。

## 六、当前落地状态

- ✅ 九个包（含主包）全部位于 `packages/`，各自有 `package.json` / `tsup` /
  `tsconfig` / `README.md` / `README.en.md` / 独立测试，可单独构建与 `require`
- ✅ 根目录**不再发布**（`private: true`），只做 workspace 管理与统一测试
- ✅ 主包**已改为引用**子包（`src/normalize.ts` 等四个文件已删除），不是复制
- ✅ 命名空间统一 `@isdk/`
- ✅ **主包不再代售子包契约**：`src/number.ts` / `text.ts` / `linguistics.ts` 三个子路径
  （以及曾短暂存在的 `markdown.ts`）已移除，主入口只剩 `src/index.ts`。
  归一化、md 摊平、否定检测等能力请从 `@isdk/*` 子包导入。
  保留的 re-export 仅限**主包 API 签名上出现的类型**
- ✅ `NormalizedText` 类型已下沉到 `@isdk/normalize-text`（主包 re-export 保持 API 不变）
- ✅ 流水线阶段 2b **已改为调用** `@isdk/identifier-variants` 的 `findIdentifierBreaks()`，
  消除了"同一规则写两遍"
- ✅ 待抽出清单已清空

## 七、目录约定

**测试与被测文件同目录**，`index.ts` 只作索引：

```
packages/normalize-text/
├── src/
│   ├── index.ts              ← 只放 export
│   ├── normalize.ts
│   ├── normalize.test.ts     ← 紧邻被测文件
│   ├── numberNotation.ts
│   ├── numberNotation.test.ts
│   ├── grapheme.ts
│   └── grapheme.test.ts
└── package.json
```

主包同理：`src/locator.ts` ↔ `src/locator.test.ts`。
特性级测试用 `被测文件.特性.test.ts`（如 `locator.punctFolded.test.ts`），
跨模块的不变量测试放 `src/invariants.test.ts`。

**属性测试**（`fast-check`）单独放 `被测文件.property.test.ts`，
用于随机输入下的不变量断言（随机文本 × 随机选项）。
目前归一化有 `normalize-text/src/normalize.property.test.ts` —— 这个包的
输入空间近乎无限，手写用例补不全。


## 八、score 的两种语义（重要）

语义层的分数**量纲不同，不可混用**：

| 来源 | 语义 | 上界 | 用途 |
|---|---|---|---|
| BM25 | 相关性**排序分** | **无界** | 只能排序 |
| 余弦相似度 | 方向相似度 | -1~1 | 近似可比 |
| 对齐（编辑距离类） | **绝对**相似度 | 0~1 | 可做阈值决策 |

所以 `@isdk/semantic-locate` 规定：

- `via: 'aligned'` → `score` 是**对齐分**，绝对、跨查询可比
- `via: 'segment'` → `score` 是归一化召回分，**仅排序意义**
- `recallRank` 是唯一跨检索器实现都可比的指标

**召回只做它擅长的事：排序。** 拿 BM25 的 `12.5` 与对齐的 `0.87`
做 `Math.min` 是错的 —— 它假设两者同量纲。


## 九、目录结构

```
packages/
├── excerpt-match/        主包：分层定位与编排
├── normalize-text/       归一化 + 坐标映射
├── md-flatten/           md 源码 ↔ 渲染文本坐标
├── approx-text-match/    近似子串定位（T3）
├── semantic-locate/      两阶段语义定位（T4）
├── whitespace-semantics/       脚本感知空白
├── identifier-variants/  标识符变体归一
├── zh-negation/          中文否定检测
└── zh-particles/         的/地/得 判定
```

根目录为 pnpm workspace，不发布。构建与测试统一在根执行：

```bash
pnpm install
pnpm test            # 跑 packages/*/src/**/*.test.ts
pnpm run typecheck
pnpm run build       # pnpm -r，按拓扑顺序构建各包
```


## 十、三档预设（preset）

主包 25 个配置项里多数是按场景决定的，故提供三档：

| | `strict` | `default` | `loose` |
|---|---|---|---|
| 场景 | 引用校验 / 取证 | 高亮 / 锚定 | 查重 / 召回 |
| `ignorePunctuation` | false | false | **true** |
| `allowSegmented` | **false** | true | true |
| `allowCrossBlock` | **false** | true | true |
| `maxCrossBlocks` | 1 | ∞ | ∞ |
| `groupingUnderscore` | false | false | **true** |
| `normalizeIdentifierSeparators` | false | false | **true** |
| `minSegmentLength` | — | 4 | 3 |
| `minFallbackScore` | — | — | 0.6 |
| `checkPolarity` | true | true | true |
| `cjkNumerals` | false | false | false |
| `ignoreParticles` | false | false | false |

**显式项永远覆盖预设**：

```ts
locateExcerpt(ex, text, { preset: 'loose', ignorePunctuation: false });
```

最后两行（三档一致）是刻意的安全底线：
`cjkNumerals` 会让「一一」与「十一」收敛成 `11`（假命中来源），
`ignoreParticles` 面对的是错字而非语义等价 —— 都不该因放宽档位而打开。

### 一个易错点

**纯文本 CJK 下跨块会退化**：段落间的换行被 CJK 空白规则直接删掉，
所以 `allowCrossBlock: false` 拦不住。想禁止跨块必须用 **md 模式**（那里才有块边界）。


## 十一、性能与缓存

### 瓶颈是摊平（实测）

800 段 md（约 6 万字符）：

```
mdast 摊平  298.6ms   ← 88%
归一化       41.7ms   ← 12%
```

### 三层缓存

| 层 | 缓存什么 | 实现 |
|---|---|---|
| 分词器 | `Intl.Segmenter` | `secondary-cache` 二层（内置 locale 固定不淘汰） |
| 摊平结果 | `FlatResult` | `createCachedFlattener`（跨 index、跨 options 共享） |
| 归一化视图 | `strict` + 无分隔符视图 | `TextIndex` 实例内惰性构建 |

**摊平缓存为何单独一层**：`TextIndex` 的缓存是实例级的，同一份文档被两个
index 持有就要解析两遍；而摊平只依赖 flattener、**不依赖 MatchOptions**。

### 缓存 key：优先 docId，回退全文

```ts
const md = createCachedFlattener(base, {
  max: 32,
  docIdOf: (src) => /^id:\s*(\S+)/m.exec(src)?.[1],
});
md.flattenById(doc, 'doc-42');  // 推荐
```

全文当 key 的问题是内存（大文档存两份）与相等性。
但 **docId 相同就意味着内容相同** —— 同一 id 下内容会变时（编辑器草稿），
让 `docIdOf` 返回 `undefined` 走全文。

## 十二、命名变更

| 旧 | 新 | 理由 |
|---|---|---|
| `createPageIndex` | **`createTextIndex`** | 它索引的是文本，不是"页面"；旧名易联想到页码 |
| `PageIndex` | `TextIndex` | 同上 |
| `verifyExcerptFromPage` | **`matchExcerpt`** | 输入是文档文本，没有页的概念；且升级为 T0–T4 全档位、结果含完整元数据 |
| `locateExcerptFromPage` | （并入 `matchExcerpt`） | 统一结果已包含全部元数据，不需要两个变体 |
| `createExcerptVerifier` | **`createExcerptMatcher`** | 与 `matchExcerpt` 同组命名；`.check()` 收敛为 `.match()` |

`createPageIndex` / `PageIndex` 曾保留为 `@deprecated` 别名，现已随 1.x 早期移除。
