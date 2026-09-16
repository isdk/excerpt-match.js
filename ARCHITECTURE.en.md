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

Packages are layered by dependency: **upper layers may depend on lower ones, never
the reverse** (verified: no cycles).

```
┌──────────────────────────────────────────────────────────┐
│ L4  root package (orchestration)                         │
│     @isdk/excerpt-match                                  │
│       locator.ts      core orchestration, the only flow  │
│       presets.ts      three presets                      │
│       languageProfiles.ts  language policy + segmenter cache │
│       fuzzyMatch.ts / semanticMatch.ts   T3/T4 adapters  │
├──────────────────────────────────────────────────────────┤
│ L3  semantic / approximate                               │
│     @isdk/semantic-locate     two-stage locating (T4)    │
│     @isdk/approx-text-match   approximate span (T3)      │
├──────────────────────────────────────────────────────────┤
│ L2  coordinate mapping (the two hardest parts)           │
│     @isdk/normalize-text     normalization + mapping     │
│     @isdk/md-flatten         md source ↔ rendered text   │
├──────────────────────────────────────────────────────────┤
│ L1  dependency-free leaves                               │
│     @isdk/whitespace-semantics   script-aware whitespace │
│     @isdk/identifier-variants    identifier variants     │
│     @isdk/zh-particles           的/地/得                │
│     @isdk/zh-negation            Chinese negation        │
└──────────────────────────────────────────────────────────┘
```

The four L1 packages are **completely dependency-free** — they are the part that is
genuinely reusable on its own.

## 3. Package dependency graph

```
                    @isdk/excerpt-match  (root)
                            │
        ┌───────────┬───────┴────┬──────────────┐
        ▼           ▼            ▼              ▼
  semantic-locate  approx-   md-flatten   normalize-text
        │          text-match     │              │
        │              │          │         ┌────┼────┬────┐
        ▼              │          ▼         ▼    ▼    ▼    ▼
   zh-negation         │    normalize-text  whitespace- identifier- zh-particles
                       │                     semantics  variants
                       └────────────────────────┘
```

Points:

- `md-flatten` depends on `normalize-text` (it produces a `NormalizedText`)
- `semantic-locate` depends on `zh-negation` (polarity guard)
- `approx-text-match` **depends on no sibling** (pure string spans only)
- the four L1 packages do not depend on each other and can be installed alone

## 4. Main flow (`locator.ts` / `locateIn`)

```
excerpt + page
    │
    ├─ buildHay: page → normalized space (flatten first in md mode)
    │      ├── strict view (separators between blocks)
    │      └── joined view (no separators, for cross-block excerpts)
    │
    ├─ T0 exact          raw.indexOf(excerpt)        → kind: exact
    ├─ T1 normalized     norm.text.indexOf(needle)   → kind: normalized
    ├─ T2 segmented      split on ellipsis, chain the anchors
    │      │                                          → kind: segmented
    │      └── both views are tried; take the **earliest** hit (position > strength)
    │
    ├─ T3 fuzzy          external matcher (dmp Bitap) → kind: fuzzy
    ├─ T4 semantic       external recall + in-segment alignment → kind: semantic
    │      └── polarity guard runs at **candidate filtering**, not after the hit
    │
    └─ spanFromNormalized: normalized interval → exact source span
           ├── map[start] / mapEnd[end-1]
           ├── expandMarkers: complete inline markers such as **
           └── snapToGraphemeBoundary: align to grapheme clusters
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
src.slice(map[0], mapEnd[len-1])  normalized  ===  text      ← the WHOLE span
```

- `mapEnd` **cannot** be derived from `map[i+1]` — escapes (`\*`) and entities (`&amp;`)
  make one visible character span several source characters
- `back` must **compose across stages** — each stage only knows "points at *its* input",
  so writing `at` directly loses length changes from earlier stages
- indices are **UTF-16 code units**, but `mapEnd` is given per **character** —
  surrogate pairs (emoji, CJK Ext-B) occupy 2 units, so `i+1` would cut one in half

**"Whole span" is not hedging.** NFKC expansion (`ﬁ` → `fi`) makes several output
characters **share** one source interval, so "character *i* maps back to itself" does
**not** hold — a single character maps back to the whole expansion. This is
deliberate and conservative (better to cut wide than to cut short) and is pinned by
property tests.

## 6. The normalization pipeline (`normalize.ts`)

Four explicit stages; **the order is a contract and must not be changed**:

```
1. foldWidth          NFKC + strip zero-width
2. normalizeNumbers   number notation   ← must be after 1, before 4
3. foldCase           case folding
4. foldPunctAndSpace  punctuation / particles / whitespace
```

Why numbers must run at 2 (full reasoning in the README, "Digit grouping" section):

- **after NFKC**: full-width `1，000` must match the grouping rule, and before NFKC it
  is `，`, not `,`
- **before punctuation folding**: the enumeration comma `、` is not folded by NFKC, so
  running earlier distinguishes `1,000` (grouping) from `1、000` (a list)

## 7. Reusing just part of it?

Every sub-package can be installed on its own and has its own README:

```ts
import { normalizeWithMap } from '@isdk/normalize-text';   // highlighting/diff need it
import { createMdastFlattener } from '@isdk/md-flatten';   // comment anchoring
import { detectNegation } from '@isdk/zh-negation';        // sentiment analysis
import { createCachedFlattener } from '@isdk/md-flatten';  // flatten cache
```

**The root package does not resell sub-package contracts.** None of the symbols above
are exported from `@isdk/excerpt-match` — the whole point of splitting is to let them
evolve independently; re-exporting them would re-couple the two (one sub-package
change forces a root-package release).

The root entry keeps only two kinds of things:

1. **APIs this package implements itself** — locating, presets, language profiles,
   T3/T4 adapter factories
2. **types that appear in those APIs' signatures** — otherwise callers cannot pass
   arguments or read return values (e.g. `NormalizedText`, `MarkdownFlattener`,
   `BitapMatcher`, `SemanticRetriever`)

Criterion for splitting: **only what nobody has done *and* what has general value**.
Chinese numerals, segmentation, Bitap, graphemes and markdown parsing all have
existing libraries — use theirs.

## 8. Where to change what

| Goal | Package | Watch out for |
|---|---|---|
| add a normalization rule | `normalize-text` | must update all of `map` / `mapEnd` / `back` |
| add a language | root `languageProfiles.ts` | first test "does dropping spaces change segmentation" |
| add a preset | root `presets.ts` | explicit options always win over the preset, never the reverse |
| add a match tier | `MatchKind` in root `types.ts` + `locator` | remember to rank it in `strength()` |
| swap the fuzzy library | `adapters.ts` in `approx-text-match` | only two functions needed: `match` and `diff` |
| change coordinate mapping | `normalize-text` / `md-flatten` | neither `mapEnd` nor grapheme snapping may be skipped |
| add a flatten cache | `cachedFlattener.ts` in `md-flatten` | prefer docId as key; same id implies same content |

**Cross-package changes**: adding one punctuation equivalence only touches
`normalize-text`; it does not leak. The only thing that truly needs coordination is
**adding a language** (touches both `languageProfiles` and `whitespace-semantics`).

## 9. Package split (already done)

Early versions of this doc argued against splitting. The criterion is
**"does a library already exist; if not, does this have general value?"**

| package | role | tier |
|---|---|---|
| `@isdk/excerpt-match` | root: tiered locating and orchestration + unified coordinates | T0–T4 |
| `@isdk/normalize-text` | normalization + source-coordinate mapping | T1 |
| `@isdk/md-flatten` | md source ↔ rendered text mapping, both ways | T0/T1 |
| `@isdk/approx-text-match` | approximate substring location (contiguous span + score) | T3 |
| `@isdk/semantic-locate` | two-stage semantic locating: retrieve → align | T4 |
| `@isdk/whitespace-semantics` | script-aware whitespace (Hangul/Thai spaces matter) | T1 |
| `@isdk/identifier-variants` | `TensorFlow` ≡ `tensor_flow` | T1 |
| `@isdk/zh-negation` | Chinese negation detection (word-boundary aware) | guard |
| `@isdk/zh-particles` | 的/地/得: particle vs content word | T1 |

**Not built in-house**: Chinese numerals (`cjk-number`), segmentation
(`Intl.Segmenter` / jieba), Bitap (`diff-match-patch-es`), graphemes
(`Intl.Segmenter`), markdown (`mdast-util-*`), caching (`secondary-cache`).

### Why number notation is not its own package

It is **position-sensitive** in the pipeline: it must run after NFKC and before
punctuation folding. Splitting it out makes it easy to place wrong — some things are
coupled not in code but in **execution order**.

## 10. Presets

25 options, most of them scene-dependent, hence `preset`:

| | `strict` | `default` | `loose` |
|---|---|---|---|
| for | citation checking / forensics | highlighting / anchoring | dedup / retrieval |
| `ignorePunctuation` | false | false | **true** |
| `allowSegmented` | **false** | true | true |
| `allowCrossBlock` | **false** | true | true |
| `checkPolarity` | true | true | true |
| `cjkNumerals` | false | false | false |
| `ignoreParticles` | false | false | false |

**Explicit options always override the preset.** The last two rows are identical on
purpose — a deliberate safety floor: `cjkNumerals` collapses 「一一」 and 「十一」 into
the same string (a source of false hits), and `ignoreParticles` faces typos, not
semantic equivalence.

## 11. Performance and caching

### The bottleneck is flattening, not normalization (measured)

800 paragraphs (~60k chars):

```
mdast flatten   298.6ms   ← 88%
normalize        41.7ms   ← 12%
```

So optimize around flattening.

### Three cache layers

| layer | caches | mechanism |
|---|---|---|
| segmenters | `Intl.Segmenter` | `secondary-cache` two-tier (builtin locales pinned) |
| flatten results | `FlatResult` | `createCachedFlattener` in `md-flatten` |
| normalized views | `strict` + joined | lazy, inside a `TextIndex` |

**Why a separate flatten cache**: `TextIndex` caching is **per-instance**, so the same
document parsed by two indexes is parsed twice. Flattening depends only on the
flattener, **not on `MatchOptions`** — rebuilding on an option change is pure waste.

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
 Test Files  25 passed (25)
      Tests  349 passed (349)
```

Total and pass/fail in one glance.

### Property tests (fast-check)

Normalization is the only "magical" part, yet its input space is nearly unbounded
(escapes, entities, zero-width, full-width, surrogate pairs, combining marks…).
Hand-written cases cannot cover combinations nobody thought of, so
`@isdk/normalize-text` carries `normalize.property.test.ts`: random text × random
option combinations, asserting idempotence, `map` monotonicity,
`map.length === text.length + 1`, whole-span round-tripping, and more.

**It is the main bug finder here**: the surrogate-pair `mapEnd` bug was caught on its
very first run, not by review.

Convention: when adding a normalization rule, first ask "which invariant does this
break?", then add the assertion to the property tests.

### Per-package devDependencies

External packages used by tests (mdast, `diff-match-patch`, jieba, `cjk-number`,
`fast-check`) live in the package that uses them, versions aligned with the root.
If a sub-package is later published standalone, its tests still run.
