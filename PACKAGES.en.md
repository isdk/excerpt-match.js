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
| `@isdk/whitespace-semantics` | script-aware whitespace: is a space typography or content | none | ✅ extracted |
| `@isdk/identifier-variants` | identifier variant folding: `TensorFlow`/`tensor_flow`/`tensor-flow` → one form | none | ✅ extracted |
| `@isdk/zh-particles` | 的/地/得 part-of-speech decision | segmenter (injected) | ✅ extracted |
| `@isdk/normalize-text` | normalization + coordinate mapping (incl. the `NormalizedText` type) | `whitespace-semantics`, `zh-particles`, `identifier-variants`, optional `cjk-number` | ✅ extracted |
| `@isdk/md-flatten` | markdown source ↔ rendered text coordinates, both ways | `normalize-text`, optional mdast | ✅ extracted |
| `@isdk/approx-text-match` | approximate substring localization: contiguous span + score | optional dmp-es | ✅ extracted |
| `@isdk/semantic-locate` | two-stage localization: retrieve a segment, then align inside it | `@isdk/zh-negation` | ✅ extracted |
| `@isdk/zh-negation` | word-boundary-aware Chinese negation detection | `Intl.Segmenter` | ✅ extracted |
| `@isdk/excerpt-match` | **root package**: tiered locating and orchestration + unified coordinates | all of the above | ✅ moved into `packages/` |

> The extraction list is **empty** — every candidate has been extracted.

> Number notation (digit grouping + Chinese numerals) is **not** its own package:
> it is **position-sensitive** in the pipeline (must run after NFKC, before
> punctuation folding), so splitting it out makes it easy to place wrong.
> It ships inside `@isdk/normalize-text`.

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

- ✅ All nine packages (root included) live under `packages/`, each with its own
  `package.json` / `tsup` / `tsconfig` / `README.md` / `README.en.md` / tests,
  buildable and `require`-able on its own
- ✅ The root is **not published** (`private: true`); it only manages the workspace
  and aggregates tests
- ✅ The root package **references** the sub-packages (duplicated source files were
  deleted), it does not copy them
- ✅ Namespace unified under `@isdk/`
- ✅ `NormalizedText` lives in `@isdk/normalize-text`
- ✅ Pipeline stage 2b **calls** `findIdentifierBreaks()` from
  `@isdk/identifier-variants`, removing "the same rule written twice"
- ✅ The extraction list is empty
- ✅ **The root package no longer resells sub-package contracts**: the
  `number` / `text` / `linguistics` subpaths are gone and the root entry is
  `src/index.ts` only. Normalization, markdown flattening, negation detection etc.
  are imported from `@isdk/*` directly. The only re-exports left are the **types
  that appear in the root package's own API signatures**


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
cross-module invariant tests live in `src/invariants.test.ts`.

**Property tests** (`fast-check`) go in `subject.property.test.ts` and assert
invariants over random input (random text × random options). Today
`normalize-text/src/normalize.property.test.ts` is the one — that package's input
space is effectively unbounded and hand-written cases cannot cover it.

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
locateExcerpt(ex, text, { preset: 'loose', ignorePunctuation: false });
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
| `verifyExcerptFromPage` | **`matchExcerpt`** | the input is document text, no pagination; upgraded to full T0–T4 with complete metadata |
| `locateExcerptFromPage` | (merged into `matchExcerpt`) | the unified result already carries all metadata; no second variant needed |
| `createExcerptVerifier` | **`createExcerptMatcher`** | named after `matchExcerpt`; `.check()` folded into `.match()` |

`createPageIndex` / `PageIndex` were kept as `@deprecated` aliases early on and have now been removed.
