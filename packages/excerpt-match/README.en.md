# excerpt-match

English | [中文](./README.md)

Determine whether an excerpt comes from a document's body text, and locate its
**exact position and length in the source (markdown) content**.

Tiered matching, language-agnostic, zero-dependency core.

---

## The problem it solves

`text` is markdown **source**, while the excerpt was copied by a user from the
**rendered document**. A rendering step sits between them:

```
md source : 本院**认为**被告构成[根本违约](http://x.com)。
rendered  : 本院认为被告构成根本违约。
copied    : 本院认为被告构成根本违约。
```

A plain `indexOf` fails: `**` and `](url)` do not exist after rendering.
This library first flattens the markdown into "text visible after rendering" while
**keeping an exact per-character mapping back to the source**, so it can both match
against visible text and return source coordinates.

> **Terminology**: this library works on **one document** (markdown source or plain
> text); there is no notion of pages or pagination. "Rendered document" below means
> what the source renders to — that is where excerpts are copied from.

## Presets

Most of the 25 options are scene-dependent; you should not re-weigh them at
every call site. Pick a `preset` once — **explicit options override it**:

```ts
locateExcerpt(ex, text, { preset: 'strict' });
locateExcerpt(ex, text, { preset: 'loose', ignorePunctuation: false });
```

| preset | for | trade-off |
|---|---|---|
| `strict` | citation checking / forensics | prefer a miss to a false hit; no cross-block, no segmented anchors, no fuzzy |
| `default` | highlighting / anchoring / notes | balanced; segmented anchors and cross-block allowed |
| `loose` | dedup / retrieval | maximize recall, rank by `score`; ignores punctuation, merges identifier variants |

All three keep `checkPolarity: true` and leave `cjkNumerals` and
`ignoreParticles` off — the first makes different words converge to the same
string (a source of false hits), the second is a typo, not a semantic equivalence.

## Quick start

```bash
npm install @isdk/excerpt-match
```

The high-level entry works with **zero configuration** — markdown flattening
(mdast + GFM), the T3 fuzzy tier (diff-match-patch-es) and the like are shipped as
mandatory dependencies and assembled automatically:

```ts
import { matchExcerpt } from '@isdk/excerpt-match';

const r = await matchExcerpt('本院认为，被告的行为构成违约', mdSource);

if (r.found) {
  // The coordinate contract always holds; source is the citable markdown snippet
  console.log(r.kind, r.score, mdSource.slice(r.index, r.index + r.length));
}
```

When matching **many** excerpts against one document, always reuse the index
(see [Performance](#performance)):

```ts
import { createExcerptMatcher } from '@isdk/excerpt-match';

const m = await createExcerptMatcher(mdSource);
for (const it of items) it.ok = (await m.match(it.excerpt)).found;
```

For coordinates only, the sync entry is `locateExcerpt` — it keeps a
**zero-dependency core with explicit injection**:

```ts
import { locateExcerpt } from '@isdk/excerpt-match';
import { createMdastFlattener } from '@isdk/md-flatten';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';

// The flattener is passed explicitly (the low-level API does not auto-assemble)
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

### Runtimes

- **Node** ≥ 20.19 (locked by `engines`). The CJS build keeps dynamic
  `import()` for pure-ESM dependencies as-is (verified against esbuild),
  so the zero-config defaults load via standard ESM in both builds.
- **Browser / Deno / edge**: the static dependency graph contains no
  `node:*` (pinned by a real-Chrome packaging test); the built-in defaults
  are loaded through **literal** dynamic `import()` so bundlers split them
  into on-demand chunks — capabilities never reached cost nothing. A
  default that cannot be resolved degrades to "no default" (capability
  off); explicit injection keeps working as before.

  **Vite users**: jieba's web build fetches its wasm at runtime via
  `new URL('jieba_bg.wasm', import.meta.url)`. Vite's dependency
  pre-bundling (dev server / vitest browser mode) rewrites such modules
  into `.vite/deps`, which breaks the relative URL (404) — exclude it in
  `vite.config.ts`:

  ```ts
  export default defineConfig({
    optimizeDeps: { exclude: ['@isdk/nlp-jieba'] },
  });
  ```

  Production builds (`vite build`) handle `new URL(…, import.meta.url)`
  assets natively and need no extra config. Without the exclusion the jieba
  default silently degrades (的/地/得 falls back to the conservative mode);
  all other capabilities are unaffected.

## Return contract

Hit or miss, the shape is the same — it **never returns `null`**:

```ts
interface ExcerptMatch {
  index: number;           // start offset within text
  length: number;          // slice(index, index + length) is the matched span
  kind: MatchKind;         // which tier matched
  score: number;           // 0..1, 1 = exact
  occurrences: number;     // hit count; >1 means ambiguous
  crossesBlocks?: boolean; // spans multiple blocks (markdown only)
  via?: string;            // which fallback produced it
}
```

On miss: `{ kind: 'none', index: -1, length: 0, score: 0 }` (i.e. `MISS`).

> Why not `null`: "does this come from the document?" is not a boolean — it is a tiered
> conclusion with confidence. Returning `null` throws away the most valuable signal,
> the *near miss*, which is exactly what OCR noise, layout drift, or light rewording
> look like.

## Tiers

| Tier | kind | Tolerates | Implemented by |
|---|---|---|---|
| T0 | `exact` | nothing | `indexOf` on visible text |
| T1 | `normalized` | whitespace / full-width / punctuation / case / zero-width | built-in normalization |
| T2 | `segmented` | ellipsis in the excerpt (`……`) | built-in anchor chain |
| T3 | `fuzzy` | typos, insertions, deletions | built-in by default (diff-match-patch-es); injectable |
| T4 | `semantic` | paraphrase, synonym rewriting | external retriever (embedding / BM25) |
| — | `none` | — | no match |

**T3 / T4 switches**: the high-level entry (`matchExcerpt`) injects the built-in T3
fuzzy matcher by default — pass `preset: 'strict'` or an explicit `fallbacks: []` to
turn it off; the low-level entry (`locateExcerpt`) never fuzzy-matches without
`fallbacks`. T4 only ever happens when a `retriever` is given.

### Choosing a configuration

| Use case | Recommendation |
|---|---|
| Citation verification / forensics | no `fallbacks`; T0–T2 only |
| Highlighting / note anchoring | `fallbacks: [fuzzy]`, `minFallbackScore: 0.85` |
| Dedup / recall | everything on; sort by `kind + score`; semantic on a separate path |

## Coordinate contract

`index` / `length` are **exact offsets and lengths within `text`**.

- In markdown mode `length` is the **source length** (markup included), which is larger
  than the rendered character count: the excerpt `被告的行为已经构成根本违约` is 13
  rendered characters but its source
  `**被告**的行为已经构成[根本违约](http://a.b/c)` is 33 characters.
- Each character carries two coordinates, `map` and `mapEnd`. `mapEnd` cannot be derived
  from `map`: escapes (`\*` → `*`) and entities (`&amp;` → `&`) make one visible
  character span multiple source characters.
- Spans are expanded outward to **complete inline markers**, so you never get a
  half-slice like `被告**的行为`: the excerpt `被告` yields the span `**被告**`.

### Known limitation

If an excerpt starts or ends *inside* an inline construct (e.g. it stops midway through
`[根本违约](url)` at `根本`), exactness and standalone renderability cannot both hold —
appending `](url)` adds `违约`, omitting it leaves a broken link.
This library chooses **exactness**; if you need a renderable fragment, expand it
yourself using `TextIndex.blocks`.

## Markdown flattening

Uses **mdast**, not regex:

- Every node carries `position.offset`, which is precisely the index mapping we need
- "What is visible after rendering" is decided by the parser, not guessed
- Tables, strikethrough, footnotes and escapes — all things regex gets wrong — come free

Deliberate, slightly counter-intuitive choices:

- **Image alt text is dropped** — it renders as `<img>`, so users cannot copy the text
- Links keep only their anchor text; URLs are discarded
- Front matter, leftover HTML, comments, table `|`, heading `#` are all discarded
- Image-only blocks do not count as blocks (they carry no text) and are skipped when
  checking cross-block adjacency

> **GFM requires both packages** — they are not alternatives but layered partners:
>
> | Package | Layer | Responsibility |
> |---|---|---|
> | `micromark-extension-gfm` | syntax / tokenization | turns `\| a \| b \|` into tokens |
> | `mdast-util-gfm` | AST | turns tokens into `table` / `tableRow` nodes |
>
> `fromMarkdown` has two distinct slots — `extensions:` (syntax side) and
> `mdastExtensions:` (AST side) — and both must be filled. With only
> `mdast-util-gfm`, the tokenizer never recognizes table syntax and no `table` node
> is ever produced.
>
> Both packages belong to the unified collective, share the same version line (`^3`),
> and **neither is deprecated** (`micromark-extension-gfm@3.0.0` shipped 2025-03).
> `remark-gfm@4.0.1` itself depends on both.
>
> `remark-gfm` is not used because it runs a unified pipeline, whereas we need the
> `position.offset` that `mdast-util-from-markdown` provides directly — the source of
> our exact coordinates.

If mdast cannot be installed, the dependency-free `regexFlattener` works, but tables,
nesting and escapes are handled imprecisely and coordinates are approximate —
not the recommended path.

### What is a "block"?

A "block" here means a **Markdown block-level element** (mdast's `paragraph` /
`heading` / `code` / `table`) — stricter than "paragraphs separated by Enter":

| Source | Block boundary |
|---|---|
| Paragraphs: an **empty line** between two lines of text | the empty line is the boundary |
| A single Enter inside a paragraph (soft break) | **not** a boundary — renders as the same paragraph |
| `## Heading` | a heading is its own block, no empty line needed |
| Code fence / table | each is its own block |

"Block" and "paragraph" coincide most of the time, but headings, code blocks,
tables, and list items each occupy a block too — and **containers** like quotes
and lists nest, with inner paragraphs still being independent blocks.

After flattening, a separator `\n` (a typographic artifact, not content) is
inserted between blocks, and each block's bounds are recorded (`blocks`). The
concept drives three behaviors:

1. **Block boundaries stop normalization** — leading/trailing punctuation and
   whitespace may fold within a block, but never merge across blocks;
2. **Cross-block adjacency is computed in blocks** — see the next section;
3. **`punctFolded`'s edge-punctuation expansion never crosses a block** — see the
   stop rules in the [`punctFolded`](#punctfolded-separating-strict-hit-from-hit-only-by-ignoring-punctuation) section.

## Cross-block excerpts

Users copying across paragraphs often **lose the line break**:

```
md   : 第一段末尾内容。\n\n第二段开头内容。
copy : 第一段末尾内容。第二段开头内容。
```

The general case: excerpts spanning a heading, a paragraph, a code block, list
items — anything that **looks continuous in the rendered document but is separated
by block boundaries in the source** (see "What is a block?" above). Copying
starts from the rendered document, which has no notion of blocks.

Block separators are a typographic artifact we insert, not content. So in addition to
the strict view, a **separator-free view** is derived, and both participate in matching.

### Adjacent blocks only — never skipping

- A hit must land on a **contiguous run** of blocks. An excerpt that skips a whole
  paragraph (`甲 / middle paragraph / 乙`) is `none` — that is the ellipsis case (T2),
  not a cross-block one.
- Adjacency is computed over **blocks that carry text**: image blocks and thematic
  breaks produce no text and do not count as skipped.
- `maxCrossBlocks` caps how many blocks a hit may span:

| Value | Meaning |
|---|---|
| `Infinity` (default) | enforce contiguity only; no segment-count limit (three consecutive paragraphs are still adjacent) |
| `2` | at most two adjacent segments |
| `1` or `allowCrossBlock: false` | no cross-block matching at all |

### Earliest wins, not strongest

Candidates from both views are compared with **position before strength**:

```
甲\n\n乙\n\n后面段落里字面出现了甲乙两字。
excerpt "甲乙" → matches the earlier 甲\n\n乙 (index 0),
                 not the later literal "甲乙" (index 16)
```

Otherwise a T0 exact match later in the document would short-circuit and bury a
cross-block match that appears earlier. Ties break by strength:
`exact` > `normalized` > `segmented`.

### Custom ellipsis patterns (T2)

Common forms (`...`, `。。。`, `…`, `〔略〕`, `[...]`) work by default. Fully
customizable, multiple patterns supported:

```ts
import { DEFAULT_ELLIPSIS } from './src';

// Replace the defaults
locateExcerpt(ex, text, { ellipsis: ['〔中略〕', /\[\s*snip\s*\]/] });

// Keep defaults and append
locateExcerpt(ex, text, { ellipsis: [...DEFAULT_ELLIPSIS, '〔中略〕'] });

// Disable T2
locateExcerpt(ex, text, { ellipsis: [] });
```

Strings match as **literals** (escaped internally, so `'...'` is not treated as a
regex); regexes are used as-is. Whitespace around each pattern is ignored.

> ⚠️ **Counter-intuitive**: splitting happens *after* normalization, and normalization
> applies NFKC folding (`〔中略〕` → `[中略]`, `，` → `,`). String patterns are therefore
> normalized with the same rules before matching — either full-width or half-width
> works. Regexes operate on normalized text, so write them against the folded form.

### Risk

Short excerpts can be ambiguous across blocks: in `甲\n\n乙\n\n甲\n\n乙`, "甲乙" can be
assembled in three places. The implementation guarantees the **first** one is returned,
and `occurrences` reports the total so callers can detect ambiguity.

## Semantic equivalence vs contradiction

This is the easiest trap in the whole library. Measured:

```
doc    : 前缀人工智能正在改变世界后缀
excerpt A : 人工智能在改变世界     0.947  ← equivalent, accept
excerpt B : 人工智能没在改变世界   0.900  ← opposite, reject
```

**They differ by only 0.047.** Character similarity cannot tell "one particle missing"
from "one negation added" — literal overlap is high in both cases. No threshold tuning
fixes this; it is the difference between **similarity** and **entailment (NLI)**: cosine /
character distance measures "how alike", while what we need is "do they mean the same".

The fix is not a model — it is one deterministic check first: **look for negations**.

```
checkPolarity: true (default)
  人工智能在改变世界    → fuzzy 0.947  ✅
  人工智能没在改变世界  → none         ✅
```

`detectPolarity` uses Chinese + English negation word lists (longest match first, so
`没有` is not split into two single-character marks) and decides polarity by the
**parity of negation marks** — double negation (`不得不`) counts as affirmative.

Three details:

- **Compare only the text inside the hit span**, not the whole document. A "not" elsewhere
  in the document is normal and must not affect the verdict.
- **Compare parity, not wording.** `不去` and `没去` use different words but are both
  negative, so they do not conflict.
- **Applies to T3 / T4 only.** T0–T2 are literal matches, so polarity is consistent by
  construction (if the document really is negative, the excerpt carries the same negation).

The test is that **the negation must be a standalone word**, guaranteed by
`Intl.Segmenter` tokenization:

```
非常 → segmented as ["非常"] (one word)     → not a negation  ✅
无锡 → ["无锡"]                            → not a negation  ✅
没有 → ["没有"]                            → negation        ✅
不去 → ["不去"] (segmenters disagree here, so a word that
      starts with a one-char negation and is ≤2 chars counts) → negation ✅
```

English contractions are matched by **word form** (`don't` as a word, or ending in
`n't`), so `don't` / `doesn't` / `isn't` are detected while `notice` / `noon` are not.

The exclusion list matches **whole words**, not prefixes — a prefix rule would
wrongly discard `无法` ("cannot") and `无论` ("no matter"), which are real negations.

The guard runs at **candidate filtering**, not after the hit — otherwise the best-scoring
candidate could be rejected on polarity grounds while a perfectly legal runner-up existed.

> Known limitation: negation **scope** is not modeled. `他没有说不去` is counted as a
> double negation, which is not what it means. Such structures are rare, and the guard's
> behavior stays predictable (conservative rejection).

## Chinese particles 的 / 地 / 得: POS matters

### Blind folding is wrong

Confusing these three is common *when they act as particles*, but they must never be
folded *when they are part of a content word* (大地 / 土地 / 得到 / 值得).
**`大地` and `大的` are two different words**, not two spellings of one word — a
fundamental difference from full-width/half-width folding.

An earlier version folded them blindly. Measured false positives:

```
「辽阔的大地」 ← 「辽阔的大的」     normalized  score 1.00  ← wrong
「这片土地」   ← 「这片土的」       normalized  score 1.00  ← wrong
「值得信赖」   ← 「值的信赖」       normalized  score 1.00  ← wrong
```

Worse, `score = 1.00` asserts "these two texts are identical", which they are not.
Fatal for citation verification / forensics.

### Use jieba POS tagging

jieba tags them as distinct particles: `uj` = 的, `uv` = 地, `ud` = 得.
**The key insight: they are separate tokens only when acting as particles.**

```
他高兴地接受了 → 他/r 高兴/b 地/uv 接受/v   ← standalone particle, foldable
这片土地       → 这片/x 土地/n              ← no standalone particle, not foldable
他得到了批准   → 得到/v                     ← no standalone particle, not foldable
```

The tokenizer naturally solves "content words containing 的/地/得" — those characters
are never standalone tokens.

```ts
import * as jieba from '@isdk/nlp-jieba';
import { createJiebaParticleTagger } from '@isdk/zh-particles';

const tagger = createJiebaParticleTagger(jieba);
locateExcerpt(ex, text, { markdown: md, ignoreParticles: tagger });
// High-level entry is simpler: matchExcerpt(ex, text, { ignoreParticles: true }) assembles jieba for you
```

Measured: **6/6 particle confusions matched, 11/11 content-word misuses rejected**.

> ⚠️ **You must call `addDefaultDict()` first**, otherwise every tag is `x` and the
> check silently does nothing. `createJiebaParticleTagger` calls it once for you.

### Three strategies

| Value | Meaning | Dependency |
|---|---|---|
| `false` (**default**) | no folding. Safest, zero false positives | none |
| `true` | conservative mode: content-word guard list. Dependency-free but incomplete | none |
| `ParticleTagger` | POS-aware. **Recommended** | WASM |

The default is `false` because **a false positive costs more than a miss**: a miss is
just one fewer hit, a false positive fabricates a citation.

That guard list is bottomless —
`大地 / 土地 / 地方 / 地址 / 得到 / 懂得 / 值得 / 获得 / 记得 / 觉得 / 显得 / 使得 /
目的地 / 根据地 / 殖民地 / 心地 / 见地 / 境地…` can never be fully enumerated by hand.
Use jieba if you can.

The fold is 1→1, so length never changes and index mapping is unaffected.

### Bundling caveat

The Node build of `@isdk/nlp-jieba` loads its binary at runtime via
`fs.readFileSync(__dirname + '/jieba_bg.wasm')` — **.wasm is a resource file, not a
module, so esbuild cannot inline it**. Bundling it produces `ENOENT: jieba_bg.wasm`.

It must therefore stay external (already configured in this project's `tsup.config.ts`):

```ts
external: ['@isdk/nlp-jieba']
```

**`esbuild-plugin-wasm` does not fix this** — it handles `import wasm from './x.wasm'`
ESM import statements, has no effect on `readFileSync`, and only supports the esm
output format (it relies on top-level await).

### Performance

`addDefaultDict()` costs about 49 ms (once); tokenization is roughly 1.5 µs per
character (6,000 chars ≈ 9 ms). With `createTextIndex` caching you pay it once when
building the index. Very long text (default > 200,000 chars) skips the check and falls
back to no folding.

## Normalization is a staged pipeline — **order is part of the design**

```
1. foldWidth         NFKC folding + strip zero-width characters
2. normalizeNumbers  numeric notation   ← position matters, see below
3. foldCase          case folding
4. foldPunctAndSpace punctuation folding / particle folding / whitespace → sentinel /
                     cross-script space removal
```

### Number normalization must run *after NFKC, before punctuation folding*

In `1,000` the comma is a pure typographic grouping mark; in `1、000` the ideographic
comma is a list separator. By stage 4 both have been folded to `,`, and **they can no
longer be told apart**.

But it also **cannot run before NFKC** — Chinese documents mostly use the full-width
`1，000`, which only becomes `,` after NFKC.

```
1,000  (half-width)  NFKC → 1,000   → matched as grouping   ✅
1，000 (full-width)  NFKC → 1,000   → matched as grouping   ✅  ← the common form
1、000 (ideographic) NFKC → 1、000  → not matched           ✅
```

This continues the "fold, don't replace" principle: **let an earlier general-purpose
fold collapse the variants, so later rules only need to recognize one form** — no
enumeration (which is never complete).

### Numeric notation

| Form | Default | Reason |
|---|---|---|
| `1,000` ≡ `1000` | **on** | the separator carries no information |
| `1，000` (full-width) | **on** | same, collapsed by NFKC first |
| `1_000` | off | `_` is usually part of an identifier |
| `一千` ≡ `1000` | off | **a different numeral system**; also `三思而行` is not numeric |

Grouping uses a strict pattern (`separator + exactly 3 digits + no digit after`), so
`1,0000`, `12,34` and `第1,2条` are never mis-handled.

### Chinese numerals: use `cjk-number`, do not hand-roll

This part **used to be 177 lines of hand-written parser — measured, that was a
mistake**. After switching to `cjk-number`:

| Input | Hand-rolled | `cjk-number` |
|---|---|---|
| `两万` | ❌ | ✅ 20000 |
| `負一百零二` | ❌ | ✅ -102 |
| `一點二三` | ❌ | ✅ 1.23 |
| `一万二千三百四十五` | ❌ | ✅ 12345 |
| `二〇二三` / `壹仟` | ✅ | ✅ |

**16/16** on pure numeral parsing, covering colloquial 「两」, years, negatives,
decimals, and chained carries.

```ts
import * as cjk from 'cjk-number';
import { createCjkNumberParser } from '@isdk/normalize-text';
locateExcerpt(ex, text, {
  cjkNumerals: true,
  cjkNumeralParser: createCjkNumberParser(cjk),  // inject the backend
});
```

> **`cjk-number` is ESM-only** (its `exports` map has only an `import` condition;
> `require` fails). The high-level entry ships it as a mandatory dependency and
> assembles it automatically (the loader falls back to the ESM entry, Node ≥ 20.19);
> the low-level entry still takes an explicit injection as shown above.

**Honest note**: switching libraries fixes **pure numeral parsing**, but the ambiguity
"is this Han character a numeral *here*" remains. Calling
`number.parse('三思而行')` on the whole string does throw, which looks like a
"not a numeral" signal; but the adapter must try **shorter spans** to obtain
`consumed` (needed for coordinate mapping), so 「三」 is parsed alone again and the
result is still `3思而行`, exactly as before.

That is an **inherent ambiguity of the language**, not an implementation defect —
which is why `cjkNumerals` still defaults to off.

## Need only part of it? Install the sub-package

This package **exposes only its own contract** (locating, presets, language
profiles, T3/T4 adapters). The capabilities underneath have been split into
standalone packages, **published separately with their own README** — install
the one you need instead of pulling in the whole matcher:

| Capability | Package |
|---|---|
| normalization + source coordinate mapping | `@isdk/normalize-text` |
| markdown source ↔ rendered text coordinates | `@isdk/md-flatten` |
| approximate span location (T3) | `@isdk/approx-text-match` |
| two-stage semantic location (T4) | `@isdk/semantic-locate` |
| script-aware whitespace | `@isdk/whitespace-semantics` |
| identifier variant folding | `@isdk/identifier-variants` |
| Chinese negation detection | `@isdk/zh-negation` |
| 的/地/得 disambiguation | `@isdk/zh-particles` |

```ts
import { normalizeWithMap, snapToGraphemeBoundary } from '@isdk/normalize-text';
import { unicodeScriptOf, canDropSpaceBetween } from '@isdk/whitespace-semantics';
import { detectNegation } from '@isdk/zh-negation';
import { createJiebaParticleTagger } from '@isdk/zh-particles';
import { createMdastFlattener } from '@isdk/md-flatten';
import { splitSegments } from '@isdk/semantic-locate';

import { createCjkNumberParser } from '@isdk/normalize-text';
import * as cjk from 'cjk-number';
// The parser backend is injected (this library ships no Chinese-numeral parser)
createCjkNumberParser(cjk).parse('一百二十三', 0); // { value: '123', consumed: 5 }

detectNegation('他没来').negated; // true
detectNegation('非常').negated;   // false (solid word, not a negation)

const flat = createMdastFlattener(fromMarkdown).flatten(mdSource);
flat.text;    // visible text after rendering
flat.map[10]; // offset of the 10th character in the markdown source
```

> Language profiles (`detectLanguageProfile` / `languageProfileFor` / `tokenize`)
> and the T3/T4 adapter factories (`createBitapFallback` / `createDmpEsFallback` /
> `locateSemantic`) are implemented **by this package** — keep importing them
> from `excerpt-match`.

> For module layering, the dependency graph, and coordinate systems, see
> **[ARCHITECTURE.en.md](./ARCHITECTURE.en.md)**.

## Prefer existing libraries; only write code when none exists

The boundary is explicit: **if the standard library or a mature package can do it, we
do not implement it**. What remains hand-written is only two things — no library
provides "normalize and still map back to source coordinates", and the orchestration
between tiers (which is business semantics, not algorithms).

| Need | Library | Notes |
|---|---|---|
| Grapheme segmentation | `Intl.Segmenter` (grapheme) | built-in, UAX #29 |
| Word segmentation | `Intl.Segmenter` (word) | built-in, uses ICU |
| Chinese POS / particles | `@isdk/nlp-jieba` | optional, WASM |
| Fuzzy location | `diff-match-patch-es` | Bitap |
| Markdown parsing | `mdast-util-*` | carries `position.offset` |
| Segmenter cache | `secondary-cache` | two-level: fixed + LRU |

### Segmenter cache: why two levels (`secondary-cache`)

`locale` comes from **user input**. With an unbounded `Map`, long-running servers
accumulate locale variants (`zh-CN` / `zh-Hans-CN` / `zh-Hans-CN-u-co-pinyin` …) —
a memory-leak vector.

But a plain LRU has a cost too: hot built-in locales can be evicted by a flood of
obscure ones, forcing repeated `Intl.Segmenter` reconstruction (not cheap).

Two levels map exactly onto the two kinds of keys:

| Level | Holds | Evicted |
|---|---|---|
| **fixed** | built-in language locales (`zh` / `en` / `ja` / `ko` / `th`…) | **never** |
| LRU | any locale passed by the caller | yes, beyond capacity |

Measured: after inserting 100 user locales, all 5 built-in locales survive.

It must also be fault-tolerant: `new Intl.Segmenter('xx-locale-0')` throws
`RangeError: Incorrect locale information provided`. An invalid locale falls back to
the default segmenter and is cached anyway (so it is not reconstructed each time) —
this was found while writing the unit tests.

### Graphemes: why this must go to `Intl.Segmenter`

Hand-written "step back to the base character" logic handles surrogate pairs and
combining marks, and nothing else. These all fail, and the rules evolve with each
Unicode release:

```
👨‍👩‍👧‍👦  ZWJ family        1 cluster (naive code splits into 4 people + ZWJ)
🇨🇳      regional indicator 1 cluster (naive code splits it in half)
👍🏽      skin tone modifier 1 cluster (naive code strips the modifier)
```

## Identifier spelling: **split, never join**

`HelloWorld` / `hello_world` / `hello-world` / `hello world` should be one identifier.
The direction matters:

```
join   Hello World → HelloWorld   ordinary word pairs get merged too  ❌
split  HelloWorld  → Hello World  inserts only where a space is missing  ✅
```

**Why splitting is safer** — there is a key asymmetry:

```
Two adjacent words with no space never occur in natural text (`thecourt` is not English)
  → "no space + camel hump" is a strong identifier signal
But "space + camel hump" is everywhere in titles and names (Hello World)
  → deleting the space on that basis is bound to cause false merges
```

And `thecourt` is lowercase-then-lowercase, so the split rule never fires at all.

```ts
{ splitCamelCase: true, normalizeIdentifierSeparators: true }
```

Both default to `false`.

**Only inside identifier context** (both sides `[A-Za-z0-9]`):

```
北京-上海  ←  北京上海    ❌ rejected  (Han on both sides: never split,
                                      otherwise two place names merge into one)
第3-5条    ←  第35条      ❌ rejected  (same for numeric ranges)
```

Known limitation: `McDonald` → `Mc Donald` and `iPhone` → `i Phone` are over-split.
But since document and excerpt go through the same transform, **the same word still
matches**; a false positive requires two *different* sources collapsing to one string.

## Three ways to write `ignorePunctuation`

"ignoring punctuation" is really three different questions; collapsing them into one
boolean makes them fight each other. Besides `boolean`, two more forms are accepted:

```ts
locateExcerpt(ex, text, { ignorePunctuation: true });               // fold to placeholder, drop decided by script
locateExcerpt(ex, text, { ignorePunctuation: 'drop' });             // drop every placeholder: bare skeleton
locateExcerpt(ex, text, { ignorePunctuation: { symbols: true } });  // backticks, + = ~ count too
locateExcerpt(ex, text, { ignorePunctuation: { keep: [/\s+/] } });  // fold punctuation only, keep word breaks
```

| Sub-decision | Option | Default |
|---|---|---|
| Which characters count | `symbols` (add `\p{S}`), `extra` (name a few) | `\p{P}` |
| Keep the placeholder? | `'fold'` / `'drop'` | `'fold'` |
| Any exceptions | `keep` protected ranges | none (omission marks protected by default, below) |

**`'drop'` drops everything**: every placeholder goes away, **including the space between Latin
words** — `ab, cd` normalizes to `abcd`, so `abcd` and `ab cd` become indistinguishable.
That trade is deliberate: dedup / recall prefers over-matching and then sorts by `score`,
but **never use it for citation checking** — it manufactures false hits. To drop only
punctuation and keep word breaks, combine it with `keep`:

```ts
{ ignorePunctuation: { mode: 'drop', keep: [/\s+/] } }  // 'hello, world' → 'hello world'
```

**Omission marks are protected by default**: `……` / `〔略〕` written by the user or the system
are *structural* separators, not typesetting. Folding them silently disables T2 segmented
anchors — enabling "ignore punctuation" would then match **less** than disabling it, the
opposite of the switch's intent. Opt out explicitly with `{ preserveEllipsis: false }`.

> A backtick `` ` `` is `Sk`, `+ = ~` are `Sm` — none of them is `\p{P}`, so they are not
> folded by default: they carry meaning in code and math text. Markdown's `**`, `` ` `` and
> `[](url)` are not folded here either — the **flatten layer** already stripped them.

## `punctFolded`: separating "strict hit" from "hit only by ignoring punctuation"

With `ignorePunctuation` enabled, excerpts that differ literally can still match. But
callers usually **only dare to cite strict hits** and want the rest reviewed by a
human — so the two need to be distinguishable.

```ts
const r = locateExcerpt(ex, text, { markdown: md, ignorePunctuation: true });
if (r.kind === 'exact' || (r.kind === 'normalized' && !r.punctFolded)) {
  cite(r);               // cite directly only on a strict hit
} else if (isHit(r)) {
  flagForHumanReview(r); // crossed a punctuation difference → human review
}
```

The meaning is "**crossed a difference**", not "folded punctuation" — the latter
would flag every hit to `true` once the option is on, leaving callers nothing to
distinguish:

| Document | Excerpt | `punctFolded` |
|---|---|---|
| `本院认为，被告…。` | `本院认为，被告…。` | `false` — punctuation identical, `exact` matches already |
| `本院认为，被告…。` | `本院认为。被告…，` | `true` — comma and full stop swapped |
| `本院认为，被告…。` | `本院认为被告…` | `true` — excerpt has no punctuation at all |

**Width differences do not count**: half-width/full-width and CJK-vs-ASCII punctuation
are handled by `ignoreWidth`, i.e. ordinary T1 normalization, and need no review
(`本院认为,被告…` ↔ `本院认为，被告…` is `false`).

It is decided by re-normalizing both sides with `ignorePunctuation: false` and
comparing — the document side is "the matched span **plus the punctuation/whitespace
immediately adjacent to each edge**", while the excerpt side is kept as-is. A
difference means the match only worked because punctuation was ignored. In
markdown mode the comparison uses the **flattened** text, so syntax markers like
`**` and `[](url)` never count as a difference.

The two sides are **deliberately asymmetric**:

- **The document side gets its edge punctuation back.** Normalization drops leading /
  trailing punctuation as optional separators, so the matched span often lacks its
  final full stop. Without adding it back, "both sides actually have the period"
  would be reported as a difference, while a **real** difference sitting on the
  edge (the document has a colon, the excerpt a full stop) would be missed — adding it
  back fixes both: what's there is there, and what it is, is what it is.
- **The excerpt side stays as-is.** Whether its punctuation exists, and what it
  is, is exactly what's being compared — nothing may be added for it.

Two stop rules, both rooted in "block boundary":

- **Stop at line breaks** (strict view): a line break is a block boundary; content
  of the next paragraph does not belong to this hit.
- **Stop at block edges** (the separator-free cross-block view): with block
  separators stripped, adjacent blocks sit flush against each other, so the line
  break rule alone cannot stop the expansion — it is clamped back to the hit
  blocks, never mistaking the next block's leading punctuation for the hit's own
  closing punctuation.

`exact` is always `false` (literally identical, so no difference can be crossed).

## Polysemy: why the default is conservative, and where the real risk is

Take `未来` — it is either the noun "future" (`他来自未来`) or a colloquial
ellipsis for "has not come" (`他未来`).

### First: polysemy itself is not a risk here

Document and excerpt go through **the same transform**, so `未来` stays `未来` on both
sides. The contract is **location**, not **interpretation**: the same string should
point at the same place.

The real risk is **different sources collapsing into one string**:

```
一一列举  →  11列举   ┐
十一列举  →  11列举   ┘ different meanings, one string ← the actual source of false hits
```

Polysemy does not do that. This is why `cjkNumerals` defaults to off, and why
polysemy needs no handling in the normalization layer.

### When it cannot be disambiguated, choose conservative

`未来` as a time noun is far more frequent than the "has not come" ellipsis:

| Choice | `他来自未来` vs `他来自过去` | `他来到了` vs `他未来` |
|---|---|---|
| **conservative (default)** | not rejected ✅ | not rejected ❌ false negative |
| aggressive | **wrongly rejected** ❌ | rejected ✅ |

**Wrong rejection costs more**: a false negative merely loses a guard, a wrong
rejection makes a legitimate excerpt unlocatable. So such words default to
**not negated**.

### Override per domain

Which sense applies depends on context — that is word-sense disambiguation (WSD),
outside this library's scope. The approach is **conservative default plus an
override hook**, not pretending it can be decided automatically:

```ts
locateExcerpt(ex, text, {
  negationLexicon: {
    negations: ['未来'],        // transcripts: treat 「未来」 as negation too
    nonNegations: ['无限制'],   // product names / terms: never a negation
  },
});
```

`nonNegations` wins over everything and can lift built-in whitelist protection —
otherwise a built-in non-negation like `未来` could never be overridden.

### Implementation: why "sequential scan inside Han spans"

Negation detection hit three traps, each corresponding to an implementation choice:

| Approach | Problem |
|---|---|
| match whole segmented tokens | `无限制套餐` segments as `["无","限制","套餐"]`, so the 「无限制」 guard never fires |
| global longest match | `不得不` (double negation → affirmative) yields only one 「不」 |
| **sequential scan inside Han spans** | ✅ merge adjacent Han tokens, whitelist first, then longest negation match |

## Mixed-script whitespace: delete only when safe

When Chinese or Japanese text embeds English words, should the space matter?
**Test: does removing it create boundary ambiguity?**

This is measurable — compare tokenization of the original against the same text with
all spaces removed:

```
Han    本院认为...  → 本院|认为|被告|违约     identical ✅ space is not meaningful
Kana   機械学習...  → 機械|学習|の|応用       identical ✅ space is not meaningful
Hangul 아버지가 방에 → 아버지가|방에|들어가신다
       아버지가방에 → 아버지가방에들어가신다  ★differs ❌ meaningful
Thai   สัญญาผิด...  → สัญญา|ผิด|เงื่อนไข      identical (word level)
Latin  The court   → The|court|held
       Thecourt    → Thecourtheld            ★differs ❌ meaningful
```

### Three roles

| Role | Meaning | Scripts | Effect of deleting |
|---|---|---|---|
| `ignorable` | pure typographic artifact | Han, Kana | none |
| `wordDelimiter` | separates words | Hangul, Latin, digits | **word-boundary ambiguity** |
| `boundary` | sentence/phrase boundary (≈ punctuation) | Thai | **sentence boundary lost** |

### Hangul and Thai: same verdict, different reasons

**Hangul** — particles attach to the preceding word, so deleting spaces makes
attachment ambiguous (a standard Korean orthography example):

```
아버지가 방에 들어가신다  = father enters the room
아버지 가방에 들어가신다  = (someone) gets into father's bag
        ↓ identical once spaces are removed
```

**Thai** — words are written together; spaces separate **sentences/phrases**. Words can
still be segmented after removal, but the sentence boundary disappears —
**equivalent to deleting the full stop in English**. That also changes meaning, so it is
also preserved.

### Cross-script boundaries are always droppable

Whitespace between scripts is typographic, unlike whitespace within a script:

```
使用 TensorFlow 框架  ≡  使用TensorFlow框架  ✅
共 100 人参加         ≡  共100人参加         ✅
สัญญา TensorFlow     ≡  สัญญาTensorFlow     ✅
```

But spaces **within** one script follow the table above and are never dropped:

```
使用 TensorFlow 框架  ←  使用 Tensor Flow 框架  ❌ rejected
共 1 000 人           ←  共 1000 人             ❌ rejected
```

Digits get their own class (`wordDelimiter`): droppable across scripts (`共 100`),
preserved between digits (`1 000 ≠ 1000`).

## Language

Language policy lives in `profiles.ts`; the core algorithm stays language-agnostic.
Language affects only:

1. Whether whitespace between CJK characters is dropped (Chinese layout does not insert
   spaces at line breaks; English must keep them)
2. Whether T3 / T4 tokenize by character or by word
3. Which locale initializes `Intl.Segmenter`

```ts
profileFor('zh').granularity;  // 'char'
profileFor('en').granularity;  // 'word'
detectProfile('本院认为被告构成根本违约').id; // 'cjk'
```

- **Chinese uses character level**: for short excerpts (a dozen characters), word-level
  fuzzy matching is less stable than character level.
- **English must use word level**: character-level 4-gram seeds appear everywhere and
  localization degrades.
- Tokenization uses the built-in `Intl.Segmenter` (ICU dictionaries) — no native
  modules such as nodejieba.

## T3 / T4: plugging in external capability

### T3 fuzzy matching

`diff-match-patch-es` is recommended:

```ts
import * as dmpEs from 'diff-match-patch-es';
const fuzzy = createDmpEsFallback(dmpEs);
locateExcerpt(ex, text, { markdown: md, fallbacks: [fuzzy] });
// The high-level entry (matchExcerpt) already injects this matcher by default
```

Existing code can keep using `createDmpFallback(new diff_match_patch())`, but that
package has not been published since 2020-05 and is marked `@deprecated`.

#### Why not jsdiff / @lowlighter/diff

The deciding factor is not "who is active" but **who has Bitap**. What we need is not
"diff two strings" but "fuzzy-locate an excerpt inside a 600 KB document" — that is dmp's
`match_main`, and jsdiff has no equivalent (it only offers full comparisons such as
`diffChars`). Using jsdiff would mean writing the entire seed-and-extend location step
ourselves.

| Candidate | Maintained | Fuzzy location | Verdict |
|---|---|---|---|
| `diff-match-patch-es` | ✅ active | ✅ | **recommended** |
| `diff-match-patch` | ❌ stale since 2020 | ✅ | kept for compatibility |
| `diff` (jsdiff) | ✅ active | ❌ | wrong capability |
| `@lowlighter/diff` | ⚠️ 3 downloads/week | ❌ | ruled out |

> Two caveats:
> 1. `diff-match-patch-es` is **pure ESM** (`exports` exposes only `.mjs`).
>    Verify `require` works if your pipeline has a CJS stage.
> 2. It is more sensitive to `matchThreshold` than the original — the same excerpt
>    returns -1 at 0.4 but matches at 0.5. So the adapter passes **no** options by
>    default and relies on the library default; only when localization fails (-1)
>    does it **retry relaxed** (looser threshold, then the proximity penalty
>    dropped). The typical case is a poisoned seed: the excerpt mixes in characters
>    absent from the document, so every seed window occurs zero times, `loc`
>    degrades to 0, and the `|loc - true position| / matchDistance` penalty pushes
>    the score past the threshold — an artifact of a bad location estimate, not of
>    poor match quality. Relaxing Bitap only shifts the window origin; whether the
>    hit stands is still decided by the diff score.

All three adapters share `createBitapFallback(match, diff)`; swapping backends only
requires two functions.

### T4 semantic recall

**External recall + in-segment realignment**, never asking the model for character offsets:

1. Offsets returned by LLMs / embeddings drift badly in long documents — tokens ≠ characters
2. Recall only needs to answer "roughly this paragraph"; precise localization is a
   deterministic problem
3. The retriever can be swapped freely without touching coordinate logic

```ts
const r = await locateSemantic(idx, '合同可以通过要约与承诺来订立', retriever, {
  aligner: fuzzy,
  minRecallScore: 0.5,
  minAlignScore: 0.5,
});
```

Without `aligner` it degrades to highlighting the whole segment at a reduced score
(`via: 'semantic:segment'`).

### Custom fallback

```ts
const myFallback: FallbackMatcher = {
  name: 'my-model',
  kind: 'semantic',
  find(needle, hay, ctx) {
    // return [{ start, end, score }] in normalized space
  },
};
```

The contract only goes as far as `[start, end)` in normalized space; the locator handles
mapping back to source — so swapping in any library never touches coordinate logic.

## High-level entry: `matchExcerpt` — the conclusion in one call

Use this when you want **one call covering T0–T4, returning conclusion + citable source
+ full metadata**:

```ts
import { matchExcerpt, createExcerptMatcher } from '@isdk/excerpt-match';

// zero configuration: markdown flattening (mdast+GFM) and the T3 fuzzy tier
// (diff-match-patch-es) are built in
const r = await matchExcerpt(excerpt, mdSource);
if (r.found) cite(r.source);       // r.source is the markdown source snippet

// configure a retriever only when you need semantic recall (T4) —
// this package ships no retriever implementation
const r2 = await matchExcerpt(excerpt, mdSource, {
  retriever,
  onHit: (ex, r) => track('hit', r),   // optional: called on hit
  onMiss: (ex, r) => track('miss', ex), // optional; silent when unset
});

// one document, many excerpts: build the index once
const m = await createExcerptMatcher(mdSource, { retriever });
for (const it of items) it.ok = (await m.match(it.excerpt)).found;
```

| Field | Meaning |
|---|---|
| `found` | whether it hit — "does it come from this text" |
| `source` | **the matched markdown snippet** = `text.slice(index, index + length)`, markers included |
| `text` | visible text without markers, for display |
| `index` / `length` / `line` | source coordinates and line number, ready for highlighting |
| `kind` / `score` / `occurrences` / `punctFolded` / `crossesBlocks` | full metadata inherited from `ExcerptMatch` — ambiguity and strictness without a second lookup |

- **Built-in defaults; explicit options always win**:

  | Option | When omitted | How to tighten |
  |---|---|---|
  | `markdown` | built-in mdast + GFM flattener | pass your own; `markdown: null` forces plain text |
  | `fallbacks` | built-in `diff-match-patch-es` fuzzy matcher | `preset: 'strict'` or explicit `fallbacks: []` |
  | `aligner` | same source as `fallbacks` (in-segment alignment for T4) | pass a custom aligner |
  | `cjkNumeralParser` | auto-assembled `cjk-number` when `cjkNumerals` is on | pass `createCjkNumberParser(cjk)` |
  | `ignoreParticles: true` | auto-upgraded to the built-in jieba tagger | pass your own `ParticleTagger` |

  `retriever` is the one option without a default — semantic recall needs external
  services (embedding / BM25); without it the semantic layer is never touched.
- **T3 / T4 stack**: `fallbacks` (T3 and any custom matchers) run in order during the sync
  phase; the semantic retriever runs only on a miss and only when `retriever` is given.
- **Async**: always `await`, decoupled from whether T4 is configured — the call site
  never changes with the tier. (Built-in defaults load lazily on demand, which is why
  `createExcerptMatcher` is async.)
- `minScore` (defaults to `minFallbackScore`, i.e. 0.75) constrains only T3/T4 — T0–T2 are always 1.
  Raise it explicitly (e.g. `0.9`) for citation checking / forensics; keep the default for dedup / recall.
- A miss is **silent by default**; add `onMiss` when you want telemetry.

Migrating from a hand-rolled `toLowerCase + includes` also buys: markdown flattening,
cross-block copies, punctuation differences, the many ellipsis spellings (**matched as an
ordered chain**, so fragments scattered across the document no longer pass), and T4 catching
title-word injection and cross-section summaries.

## Which entry point

| API | Sync | Tiers | Returns | For |
|---|---|---|---|---|
| `matchExcerpt` | async | **T0–T4** | conclusion + source snippet + full metadata | one call: verify, cite, batch checks |
| `createExcerptMatcher` / `.match()` | async | **T0–T4** | same | one configuration reused for many excerpts (index built once) |
| `locateExcerpt` | sync | T0–T3 | `ExcerptMatch` coordinates | just coordinates; orchestrate callbacks yourself |
| `createTextIndex` / `index.locate` | sync | T0–T3 | same | many excerpts per text, reused index |
| `locateSemantic` | async | T4 | `ExcerptMatch` | coordinate adapter for custom retrieval flows |

In one line: **conclusion → `matchExcerpt`; coordinates → `locateExcerpt`**;
`locateSemantic` is an implementation layer regular callers need not touch.

## Performance

Normalization of the whole document (including markdown flattening) is O(n) and heavy. Calling
`locateExcerpt` per excerpt repeats the full-document work every time.

```ts
const idx = createTextIndex(text, { markdown: md }); // normalize once
for (const it of items) idx.locate(it.excerpt);      // then just match
```

Measured:

| Scenario | One-shot | Reusing index |
|---|---|---|
| 600 KB plain text | ~200 ms | ~7 ms |
| 12 KB markdown | ~60 ms | ~4 ms |

## Module layout

```
src/types.ts      shared return contract + pluggable interfaces
src/normalize.ts  normalization + source index mapping (the only "magic"; no library does this)
src/profiles.ts   language policy: whitespace handling, tokenization granularity
src/markdown.ts   md source → visible text + exact source mapping
src/locator.ts        T0/T1/T2 deterministic tiers + fallback orchestration + coordinate mapping
src/fuzzyMatch.ts     T3 adapter: diff-match-patch in this package's coordinate system
src/semanticMatch.ts  T4 adapter: semantic recall in this package's coordinate system
src/excerptMatcher.ts high-level entry: T0–T4 orchestration, conclusion + source + metadata
```

Only three things are written here; everything else delegates to existing libraries:

1. Normalization + index mapping (no library offers "normalize and still map back")
2. Mapping normalized space → source coordinates (no library knows our coordinate system)
3. Tier orchestration and thresholds (business semantics)

## Development

```bash
npm test              # vitest run, 350+ tests (Node tier)
npm run test:browser  # packaging tests in real Chrome (skipped when absent)
npm run typecheck     # tsc --noEmit
npm run build         # tsup, emits ESM + CJS + .d.ts
```

Coverage includes: per-tier cases, coordinate round-trip property tests (random slices),
cross-block adjacency and first-match ordering, escape/entity exactness,
and normalization idempotence.

The browser-tier defaults test (`src/defaults.browser.test.ts`) runs the same
zero-config pipeline inside **real Chrome**: the md flattener (mdast + GFM),
`diff-match-patch-es`, `cjk-number` and jieba (web wasm build + dictionary)
defaults must load, and hits must map back to source coordinates. It pins
two invariants: the static dependency graph contains no `node:*` (any
Node-only primitive sneaking in gets externalized by vite and blows up at
runtime — the test goes red on the spot), and dynamic imports use literal
specifiers only (a variable-form `import(id)` is an unresolvable bare
specifier in the browser — a real bug this test caught).

Convention: browser-only tests are named `*.browser.test.ts`; the default
Node config (`vitest.config.ts`) excludes them entirely, so `npm test`
results contain no skipped browser cases.

Requirements: `@vitest/browser` + `playwright` (already in devDependencies).
It prefers your local Chrome via `channel: 'chrome'`, falling back to the
engine managed by `@playwright/browser-chromium` (downloaded on postinstall;
allowed via `allowBuilds` in the root `pnpm-workspace.yaml`). With neither
present the whole suite is skipped — `npm test` and the root workspace run
are unaffected.
