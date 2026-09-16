# Package Layout

> Principle: **use an existing library whenever one exists**; only extract a package
> when **nobody has done it and it has general value**.
>
> All packages live under the `@isdk/` namespace.

## 1. First, a clarification: T3 here is *not* spell checking

You said T3 belongs to spell checking / correction — **the underlying algorithms are indeed
 the same family (approximate string matching)**,
but **the shape of the requirement differs**, and that decides whether to abstract it:

| | 拼写检查 / 模糊搜索 | **本库 T3** |
|---|---|---|
| Input | a word / short query | an excerpt |
| Output | **closest item in a candidate set** | a **contiguous span** in a long text + score |
| Typical lib | SymSpell / Fuse / fuzzysort | dmp `match_main` |

Measured (29-char page; excerpt drops 「的」 and 「已经」):

```
fuzzysort : indexes = [0,1,2,3, 5,6,7,8,9, 12,...,17]   ← 分散的匹配字符
            连续? false
Fuse.js   : matches = [[0,3],[5,9],[12,17]]              ← 分散片段
本库 T3   : { index: 0, length: 18, score: 0.909 }       ← 连续区间 ✅
```

**The key difference**: fuzzy-search libraries answer "which characters matched";
 this library needs "which span matched".
The former cannot produce the latter — the unmatched characters it skips (punctuation at
 4/10/11 above) **must be included in the span** for the latter,
 otherwise highlighting loses characters.

So: **using dmp's Bitap for localization is correct — do not swap in a spell checker**.
But the need "given a pattern, find a **contiguous span + score** in a long text"
has no dedicated library — which is the reason `@isdk/approx-text-match` exists.

## 2. Full package list

### Already extracted (usable standalone)

| Package | Responsibility | Deps | Status |
|---|---|---|---|
| `@isdk/whitespace-semantics` | script-aware whitespace: is a space typography or content | 无 | ✅ extracted |
| `@isdk/identifier-variants` | identifier variant folding: `TensorFlow`/`tensor_flow`/`tensor-flow` → one form | 无 | ✅ extracted |

### To extract (hand-rolled here, generally useful)

| Package | Responsibility | Tier | Deps | Value |
|---|---|---|---|---|
| `@isdk/normalize-text` | normalization + coordinate mapping (incl. the `NormalizedText` type) | T1 | `cjk-number` | **highest** — no library offers "point back to the source after transform" |
| `@isdk/approx-text-match` | approximate substring localization: contiguous span + score | **T3** | 可选 dmp | **high** — see above, no mature library |
| `@isdk/md-flatten` | markdown source ↔ rendered text coordinates, both ways | T0/T1 | mdast | **high** — needed for comment anchoring, document diff |
| `@isdk/semantic-locate` | two-stage localization: retrieve a segment, then align inside it | **T4** | 注入 retriever | 中 —— 是"模式"而非算法 |
| `@isdk/zh-negation` | word-boundary-aware Chinese negation detection | 守卫 | `Intl.Segmenter` | 中 —— 情感分析/法务可用 |
| `@isdk/zh-particles` | 的/地/得 part-of-speech decision | T1 | 分词器（注入） | 中低 —— 强依赖分词器 |
| `@isdk/number-notation` | digit grouping + Chinese numerals (wraps `cjk-number`) | T1 | `cjk-number` | 中低 —— 但**含位置敏感的顺序约束** |

### Explicitly **not** hand-rolled

| Capability | Use | Why |
|---|---|---|
| 中文数词 | `cjk-number` | 16/16 measured; 177 hand-rolled lines deleted |
| 分词 / 词性 | `Intl.Segmenter` / `@isdk/nlp-jieba` | built-in first; jieba for heavy cases |
| 模糊定位算法 | `diff-match-patch-es` | the only mature Bitap implementation |
| 字形簇 | `Intl.Segmenter` | evolves with Unicode; hand-writing never keeps up |
| md 解析 | `mdast-util-*` | every node carries an offset |
| 语义向量 | 外部 embedding | should not be hand-rolled |
| 缓存 | `secondary-cache` | two-tier structure matches the need |

## 3. How to split out T3 / T4

### T3 → `@isdk/approx-text-match`

What gets extracted is not "calling dmp" but two things dmp does not handle:

1. **seed-and-extend**：摘录里挑"在页面中出现次数最少"的种子 → Bitap 定位 → 双向扩展。
   Bitap degrades on long patterns, so passing the whole excerpt is unstable.
2. **Determining the span boundary**: dmp's `match_main` **returns only a start, no length**.
   This library refines the end via diff and snaps it to grapheme boundaries.

外部契约：

```ts
interface ApproxMatch {
  start: number;
  end: number;      // 连续区间，含中间的不匹配字符
  score: number;    // 0~1
}
```

### T4 → `@isdk/semantic-locate`

T4 的真正价值不是"算向量"（那should not be hand-rolled），而是**两阶段定位这个模式**：

```
外部召回（embedding / BM25）→ 只知道"大概是这一段"
        ↓
段内再对齐 → 精确到字符下标
```

**Why not let the model emit character offsets directly**: offsets from LLM/embedding
 drift in long texts
(tokens ≠ characters). Retrieval only needs to answer "which segment";
 precise localization is a deterministic problem.

Extractable parts:
- `splitSegments(text, maxLen)` —— split into segments at semantic boundaries (thin but general)
- two-stage orchestration + polarity guard + degradation (highlight the whole segment
 and lower the score when no aligner is given)

## 4. Where `NormalizedText` belongs

You are right: **it is a type, not a function, and it exists for coordinate mapping —
 so it belongs in
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

The name is `normalize-text`; `with-map` is a feature, not the subject — adjusted already.

## 5. On "changing one rule requires a cross-package release"

**That argument did not hold up; I withdraw it.**

Change the package the rule lives in — adding a punctuation equivalence only touches
 `normalize-text`.
Only two things actually need coordination:

1. **阶段顺序**（数字必须在 NFKC 之后、标点之前）—— orchestration lives inside `normalize-text`; it does not leak
2. **新增语言** —— 需同时动 `languageProfiles` 与 `whitespace-semantics`

Changing one normalization rule day to day needs no cross-package release.

## 6. Current status

- ✅ `packages/` 目录已建，两个包零依赖、可独立构建
- ✅ 主包**已改为引用**子包（`src/unicodeScript.ts` 已删除），不是复制
- ✅ 命名空间统一 `@isdk/`
- ⚠️ `identifier-variants` 已暴露 `findIdentifierBreaks()` 供带坐标场景复用，
  但主包流水线的阶段 2b 尚未改成调它 —— 判定逻辑已验证 10/10 一致，代码仍是两份
- ⬜ `normalize-text` 尚未抽出（下一个目标）


## 7. Directory convention

**Tests live next to the file under test**; `index.ts` is a pure barrel:

```
packages/normalize-text/
├── src/
│   ├── index.ts              ← exports only
│   ├── normalize.ts
│   ├── normalize.test.ts     ← next to the file it tests
│   ├── numberNotation.ts
│   ├── numberNotation.test.ts
│   ├── grapheme.ts
│   └── grapheme.test.ts
└── package.json
```

Same in the root package: `src/locator.ts` ↔ `src/locator.test.ts`.
Feature-level tests use `subject.feature.test.ts` (e.g. `locator.punctFolded.test.ts`);
cross-module property tests live in `src/invariants.test.ts`.

## Extra note: T3

`@isdk/approx-text-match` is extracted. What it owns is **not** the diff algorithm
(that comes from `diff-match-patch-es`), but the two things no library does:

1. **seed-and-extend** — Bitap degrades on long patterns, so pick the seed that
   occurs fewest times in the page, locate it, then open a window.
2. **Determining the span boundary** — `match_main` returns **only a start, no
   length**; the end has to be refined via diff.


## 8. Two meanings of `score`

Semantic scores are **not on the same scale**:

| source | meaning | bound | use |
|---|---|---|---|
| BM25 | **ranking** relevance | **unbounded** | ordering only |
| cosine | directional similarity | -1~1 | roughly comparable |
| alignment (edit-distance) | **absolute** similarity | 0~1 | threshold decisions |

So `@isdk/semantic-locate` declares:

- `via: 'aligned'` → `score` is the **alignment** score, absolute, comparable across queries
- `via: 'segment'` → `score` is a normalized recall score, **ordering only**
- `recallRank` is the only metric comparable across retriever implementations

**Recall does what it is good at: ordering.**
Taking `Math.min` of BM25's `12.5` and an alignment `0.87` is wrong —
it assumes both are on the same scale.


## 9. Directory layout

```
packages/
├── excerpt-match/        root package: tiered locating and orchestration
├── normalize-text/       normalization + coordinate mapping
├── md-flatten/           md source ↔ rendered text coordinates
├── approx-text-match/    approximate substring location (T3)
├── semantic-locate/      two-stage semantic locating (T4)
├── whitespace-semantics/       script-aware whitespace
├── identifier-variants/  identifier variant normalization
├── zh-negation/          Chinese negation detection
└── zh-particles/         的/地/得 particle judgment
```

The root is a pnpm workspace and is not published:

```bash
pnpm install
pnpm test
pnpm run typecheck
pnpm run build
```


## 10. Three presets

The root package has 25 options; most are scene-dependent:

| | `strict` | `default` | `loose` |
|---|---|---|---|
| for | citation checking | highlighting | dedup / retrieval |
| `ignorePunctuation` | false | false | **true** |
| `allowSegmented` | **false** | true | true |
| `allowCrossBlock` | **false** | true | true |
| `maxCrossBlocks` | 1 | inf | inf |
| `checkPolarity` | true | true | true |
| `cjkNumerals` | false | false | false |
| `ignoreParticles` | false | false | false |

**Explicit options always override the preset:**

```ts
locateExcerpt(ex, page, { preset: 'loose', ignorePunctuation: false });
```

### One gotcha

**Cross-block degenerates in plain-text CJK**: the newline between paragraphs
is dropped by the CJK whitespace rule, so `allowCrossBlock: false` cannot stop
it. Use **markdown mode** if you need to forbid cross-block.


## 11. Performance and caching

Measured on 800 paragraphs (~60k chars): mdast flatten **298.6ms (88%)**,
normalize 41.7ms. So optimize around flattening.

| layer | caches | mechanism |
|---|---|---|
| segmenters | `Intl.Segmenter` | `secondary-cache` two-tier |
| flatten results | `FlatResult` | `createCachedFlattener` |
| normalized views | `strict` + joined | lazy, inside `TextIndex` |

Cache keys prefer `docId` and fall back to full text:

```ts
md.flattenById(doc, 'doc-42');
```

**Same docId implies same content** — if content can change under one id,
let `docIdOf` return `undefined` to fall back to full text.

## 12. Renames

| old | new | why |
|---|---|---|
| `createPageIndex` | **`createTextIndex`** | it indexes text, not a "page" |
| `PageIndex` | `TextIndex` | same |

Old names remain as `@deprecated` aliases.
