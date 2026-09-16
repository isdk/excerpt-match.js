# Architecture

> For reviewers. After reading this you should be able to change any module
> without reading all of the source.

## 1. In one sentence

**Do string search in a "normalized text space", then map the found interval back to
precise source coordinates.**

Nearly all the complexity sits in two things:

1. **preserving coordinates while normalizing** (no library does this; must be hand-written)
2. **cutting the matched interval back into an exact source span**

Everything else is orchestration and trade-offs around those two.

## 2. Layers

Modules are layered by dependency: **upper layers may depend on lower ones, never the
reverse** (verified: no cycles).

```
┌──────────────────────────────────────────────────────────┐
│ L4  entry                                                  │
│     index.ts (69)              re-export only             │
├──────────────────────────────────────────────────────────┤
│ L3  orchestration / adapters                                           │
│     locator.ts (716)       ← the only main flow        │
│     markdown.ts (552)      ← markdown flattening (reusable alone)         │
│     fuzzyMatch.ts (299)    ← T3 adapter                   │
│     semanticMatch.ts (212) ← T4 adapter                   │
├──────────────────────────────────────────────────────────┤
│ L2  normalization                                                │
│     normalize.ts (697)     ← hardest part; see below              │
│     negation.ts (267)      ← polarity guard                     │
│     languageProfiles.ts (240)                            │
├──────────────────────────────────────────────────────────┤
│ L1  无依赖的叶子                                          │
│     chineseParticles.ts (221)  的/地/得                   │
│     numberNotation.ts (177)    number notation (reusable alone)       │
│     grapheme.ts (77)           graphemes                     │
│     unicodeScript.ts (84)      script classes                   │
├──────────────────────────────────────────────────────────┤
│ L0  contract                                                  │
│     types.ts (605)         pure types + the NO_MATCH constant          │
└──────────────────────────────────────────────────────────┘
```

Numbers in parentheses are line counts. Total: 4,216 lines of source + 1,572 of tests.

## 3. Module dependency graph

```
types  ◄──────────────────┬──────────────┬─────────────┐
  ▲                       │              │             │
  │              chineseParticles   numberNotation  grapheme
  │                    ▲            ▲              ▲     ▲
  │                    │            │              │     │
  │              ┌─────┴────────────┴──────┐       │     │
  │              │     normalize           │───────┘     │
  │              └──────────┬──────────────┘             │
  │                         │                            │
  │              unicodeScript ──┐                       │
  │                    ▲         │                       │
  │              languageProfiles│                       │
  │                    ▲         │                       │
  │                negation ─────┘                       │
  │                    ▲                                 │
  ├────────────────────┼─────────────────────────────────┤
  │              markdown                                │
  │                    ▲                                 │
  └──────────────  locator  ←── semanticMatch            │
                      ▲                                  │
                fuzzyMatch                               │
                                                          │
  index.ts 汇总以上全部 ────────────────────────────────────┘
```

`semanticMatch` → `locator` only **borrows `spanFromNormalized` for coordinate mapping**,
not the main flow, so it is not a cycle.

## 4. Main flow (`locator.ts` / `locateIn`)

```
摘录 + 页面
    │
    ├─ buildHay：页面 → normalization空间（md 模式先摊平）
    │      ├── strict 视图（块间有分隔符）
    │      └── joined 视图（块间无分隔符，供跨块摘录）
    │
    ├─ T0 精确        raw.indexOf(excerpt)             → kind: exact
    ├─ T1 normalization      norm.text.indexOf(needle)        → kind: normalized
    ├─ T2 分段锚点    省略号切成多段链式定位              → kind: segmented
    │      └── 两个视图都试，取**最早**的命中（位置 > 强度）
    │
    ├─ T3 模糊        外部 matcher（dmp Bitap）          → kind: fuzzy
    ├─ T4 语义        外部 embedding 召回 + 段内对齐      → kind: semantic
    │      └── polarity guard在**候选过滤**阶段，不是命中后
    │
    └─ spanFromNormalized：normalization区间 → 源码精确 span
           ├── map[start] / mapEnd[end-1]
           ├── expandMarkers：补齐 ** 等行内标记
           └── snapToGraphemeBoundary：对齐graphemes
```

## 5. Coordinate systems (read before changing anything)

**Mixing up four coordinate systems is the most common source of bugs**:

| System | Used by | Convert via |
|---|---|---|
| ① markdown source | `ExcerptMatch.index/length` (**the public contract**) | — |
| ② flattened visible text | `FlatResult.text` | `flat.map[i]` → ① |
| ③ normalized text | `NormalizedText.text` | `map[i]` → ①, `back[i]` → ② |
| ④ no-separator view | cross-block matching | derived from ②③ (array filter) |

Key invariant:

```
src.slice(map[i], mapEnd[i])  normalization后  ===  text[i]
```

- `mapEnd` **cannot** be derived from `map[i+1]` — escapes (`\*`) and entities (`&amp;`)
  make one visible character span several source characters
- `back` must **compose across stages** — each stage only knows "points at *its* input",
  so writing `at` directly loses length changes from earlier stages

## 6. The normalization pipeline (`normalize.ts`)

Four explicit stages; **the order is a contract and must not be changed**:

```
1. foldWidth          NFKC + 剔零宽字符
2. normalizeNumbers   数字记法          ← 必须在 1 之后、4 之前
3. foldCase           大小写
4. foldPunctAndSpace  标点 / 助词 / 空白
```

Why numbers must run at 2 (full reasoning in the README, "Digit grouping" section):

- **after NFKC**: full-width `1，000` must match the grouping rule, and before NFKC it
  is `，`, not `,`
- **before punctuation folding**: the enumeration comma `、` is not folded by NFKC, so
  running earlier distinguishes `1,000` (grouping) from `1、000` (a list)

## 7. Reusing just part of it

The L1 layer has no dependencies at all and can be used standalone:

| Capability | Import | Deps |
|---|---|---|
| Chinese numeral parsing | `parseChineseNumeral` | none |
| Digit grouping | `stripGroupingSeparators` | none |
| Graphemes | `snapToGraphemeBoundary` | none |
| Script classes | `unicodeScriptOf` | none |
| Negation detection | `detectNegation` | `languageProfiles` |
| Markdown flattening | `createMdastFlattener` | mdast |

If you only need these, **you do not need the whole matcher** — see "subpath exports"
  in the README.

## 8. Where to change what

| Goal | Change | Watch out for |
|---|---|---|
| add a normalization rule | `normalize.ts` stage 4 | must update all of `map`/`mapEnd`/`back` |
| add a language | `languageProfiles.ts` | first test "does dropping spaces change segmentation" |
| add a match tier | `MatchKind` in `types.ts` + `locator` | remember to rank it in `strength()` |
| swap the fuzzy library | `fuzzyMatch.ts` | the adapter contract only reaches normalized-space coords |
| change coordinate mapping | `spanFromNormalized` | do not skip `mapEnd` or grapheme snapping |

## 9. Why this is not split into packages

4,216 lines, 18 top-level exports, 1 runtime dependency — at this size the cost of
 splitting outweighs the benefit:

- the core tension is that **normalization and coordinate mapping are tightly coupled**;
  splitting forces two packages to share `NormalizedText`, i.e. no real split
- cross-package versioning turns "change one normalization rule" into a coordinated
  multi-package release

**What actually reduces complexity is layering and documentation, not physical
 splitting.** If you do need to reuse part of it independently,
use `exports` subpath entries (see the README) — no package split required.


## 8. Packages (now split)

Early versions of this doc argued against splitting. The criterion is
**"does a library already exist; if not, does this have general value?"**

| package | role | layer |
|---|---|---|
| `@isdk/excerpt-match` | root: orchestration + coordinate system | T0–T4 |
| `@isdk/normalize-text` | normalization + source-coordinate mapping | T1 |
| `@isdk/md-flatten` | md source ↔ rendered text mapping | T0/T1 |
| `@isdk/approx-text-match` | approximate span location | T3 |
| `@isdk/semantic-locate` | two-stage semantic locating | T4 |
| `@isdk/whitespace-semantics` | script-aware whitespace | T1 |
| `@isdk/identifier-variants` | `TensorFlow` ≡ `tensor_flow` | T1 |
| `@isdk/zh-negation` | Chinese negation detection | guard |
| `@isdk/zh-particles` | 的/地/得 particle judgment | T1 |

**Not built in-house**: Chinese numerals (`cjk-number`), segmentation
(`Intl.Segmenter` / jieba), Bitap (`diff-match-patch-es`), graphemes
(`Intl.Segmenter`), markdown (`mdast-util-*`), caching (`secondary-cache`).

## 9. Performance and caching

### The bottleneck is flattening, not normalization (measured)

800 paragraphs (~60k chars):

```
mdast flatten   298.6ms   ← 88%
normalize        41.7ms   ← 12%
```

### Three cache layers

| layer | caches | mechanism |
|---|---|---|
| segmenters | `Intl.Segmenter` | `secondary-cache` two-tier (builtin locales pinned) |
| flatten results | `FlatResult` | `createCachedFlattener` in `md-flatten` |
| normalized views | `strict` + joined | lazy, inside a `TextIndex` |

**Why a separate flatten cache**: `TextIndex` caching is **per-instance**,
so the same document parsed by two indexes is parsed twice. Flattening depends
only on the flattener, **not on `MatchOptions`** — rebuilding on an option
change is pure waste.

### Reuse payoff

| usage | 800 paragraphs, per call |
|---|---|
| reuse `TextIndex` | 1.96ms |
| rebuild each time | 165.5ms |

### Cache keys: docId first, full text as fallback

```ts
const md = createCachedFlattener(base, {
  max: 32,
  docIdOf: (src) => /^id:\s*(\S+)/m.exec(src)?.[1],
});
md.flattenById(doc, 'doc-42');
```

Full text as key wastes memory (large docs get stored twice) and cannot express
"two versions of one document". But note: **same docId implies same content** —
if content changes under one id (a live editor draft), return `undefined` from
`docIdOf` to fall back to full text.

id keys carry a `\u0000id:` prefix so they cannot collide with a full-text key.

## 10. Presets

| | `strict` | `default` | `loose` |
|---|---|---|---|
| for | citation checking | highlighting | dedup / retrieval |
| `ignorePunctuation` | false | false | **true** |
| `allowSegmented` | **false** | true | true |
| `allowCrossBlock` | **false** | true | true |
| `checkPolarity` | true | true | true |
| `cjkNumerals` | false | false | false |
| `ignoreParticles` | false | false | false |

**Explicit options always override the preset.**


## 12. Test layout

| level | command | output |
|---|---|---|
| all | `pnpm test` | **one run, one summary line** |
| one package | `pnpm --filter @isdk/zh-negation test` | just that package |

### Why `vitest.workspace.ts` instead of `pnpm -r run test`

The latter runs each package separately, producing 9 independent
`Test Files / Tests` blocks you have to add up yourself. Workspace mode
aggregates them:

```
 Test Files  19 passed (19)
      Tests  253 passed (253)
```

Total and pass/fail in one glance.

### Why there are no path aliases

pnpm workspaces already symlink `@isdk/*` to `packages/*`, so:

- each package's `main` / `module` / `types` / `exports` point at
  **`src/index.ts` during development**
- `publishConfig` switches to `dist` on publish

Tests therefore resolve to source, never depend on build output, and
`tsconfig.json` needs no `paths`. The earlier `vitest.shared.ts` (aliases
everywhere) was redundant — pnpm is a monorepo tool; aliasing duplicated
what it already does.

### Per-package devDependencies

External packages used by tests (mdast, `diff-match-patch`, jieba, `cjk-number`)
live in the package that uses them, versions aligned with the root.
