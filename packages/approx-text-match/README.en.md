# @isdk/approx-text-match

English | [中文](./README.md)

Approximate substring location: the most similar contiguous span + score

## What it solves

**How it differs from fuzzy-search libraries**:

| | fuzzy search (Fuse / fuzzysort / SymSpell) | this package |
|---|---|---|
| answers | which characters matched | which **span** matched |
| output | scattered match indices | `{ start, end, score }` |

The former cannot derive the latter: characters that fuzzy search **skips**
(say punctuation) must be **included** in a span, or highlighting loses text.

**No reinventing**: the diff algorithm comes from a library. This package owns
only the two things libraries do not:

1. **seed-and-extend** — Bitap is bit-parallel, so patterns are capped at 32
   characters; longer ones throw `Pattern too long`. Pick a short **seed**
   (≤ 24 chars by default), locate it, then open a window around it.
2. **Span boundary** — `match_main` returns **a start but no length**;
   refine the end via diff

jsdiff is excluded not for quality but for capability: no fuzzy locating.

## How it works

```
1. pick a seed   a short slice of the excerpt (≤ 24 chars) as a probe
                     ↓
2. locate        Bitap finds the seed's rough position in the full text
                     ↓
3. open window   centre on that hit, `slack` chars (64) on each side
                     ↓
4. refine        diff, take the first-common → last-common span
                 → { start, end, score }
```

### A seed must be rare *and present* — the easiest thing to get wrong

A seed is an anchor, so rarity is what makes it useful — hence the intuitive
rule "pick the one that occurs fewest times". But **zero is not rarest, it is
absent**: excerpts routinely carry characters the document never had (md
markers `**`, mangled list numbers, OCR noise…), and any window containing one
occurs **zero** times. Zero hits in a dictionary does not mean you found a
precise entry — it means you misspelled the word. Bitap, handed a string that
does not exist in the text, comes back empty.

So the real rule is: **ask whether it exists before asking how rare it is** —
pick the window with the **fewest non-zero** occurrences. Only when *every*
window is absent do zero-count windows become candidates, and then they are
ranked by "how poisoned" they are (how many of their characters do occur in
the text).

> Without this guard: `**甲方**应当按照合同约定支付货款` would pick
> `**甲方**应当` → Bitap returns -1 → **the whole excerpt fails to locate**,
> even though `应当按照合同` inside it would have hit.

### Why the score uses a span, not summed differences

The denominator is `last - first` (the window span from the first common chunk
to the last), not the sum of all difference chunks. Summing them folds
unrelated trailing text into the denominator, which drives the score to 0 on
long windows (measured on a Chinese dropped-character case: 0.63 summed vs
0.875 by span).

```
window = 本院认为，被告的行为已经构成根本违约，应当赔偿。
needle = 本院认为被告的行为构成根本违约

common    本院认为(4) 被告的行为(5) 构成(2) 根本违约(4)  → common = 15
span      first = 0, last = 18     (3 chars of 「，」「已经」 folded in)
score     2×15 / (18 + 15) = 0.909
```

## Usage

```bash
npm i @isdk/approx-text-match
```

```ts
import * as dmp from 'diff-match-patch-es';
import { createDmpEsFallback } from '@isdk/approx-text-match';

const fuzzy = createDmpEsFallback(dmp);
fuzzy.find('本院认为被告的行为构成根本违约', '本院认为，被告的行为已经构成根本违约，应当赔偿。');
// → [{ start: 0, end: 18, score: 0.909 }]
```

Highlight with `text.slice(start, end)` — unmatched characters in between are
inside the span, so nothing is dropped.

### Finding several hits

By default you get the **single best** span. To find several approximate
occurrences of one excerpt, pass `maxMatches`:

```ts
const fuzzy = createDmpEsFallback(dmp, { maxMatches: 3, minScore: 0.8 });
fuzzy.find('甲方应当按照合同约定支付货款', doc);
// → [{ start, end, score }, …]  up to 3, sorted by score descending
```

**Always set `minScore` when `maxMatches > 1`**: Bitap is fuzzy, and the 2nd
and 3rd hits score far below the 1st (measured: correct hits ~0.9, a wrong
position only 0.135). Without a floor, the tail of the list is noise.

Bitap returns one position per call, so the Nth hit is found by **masking the
already-matched span and relocating**: matched regions are replaced with an
equal-length sentinel string, which cannot match, so Bitap naturally looks
elsewhere. Cost: one string rebuild per round, O(`maxMatches` × text length).

## Boundaries and trade-offs

- **Do not pass `threshold` by default** — `threshold` sets Bitap's accuracy
  bar (`errors / pattern.length`). At `0.4` an excerpt with ~40–50% differing
  characters returns -1 where `0.5` still hits. This is a plain accuracy
  threshold, **not** an es-build quirk: both backends score identically
  (verified line-by-line). `createDmpEsFallback` omits it so the library
  default (0.5) applies; `createDmpFallback` defaults to **0.4** — the
  divergence is legacy, and "aligning" them would silently change hits for
  existing callers
- **Bitap returning -1 relaxes, but only after checking whether `loc` is
  trustworthy**: a poisoned seed has no exact occurrence, so `loc` degrades to
  0 and the `|loc - true position| / matchDistance` penalty explodes (true
  position 1127 with distance 1000 → penalty 1.127). That penalty is an
  artifact of a bad location estimate, not of poor match quality — so in that
  case the adapter **keeps the threshold strict and only drops proximity**.
  When `loc` *is* trustworthy it first loosens the threshold (keeping the
  location prior), then drops proximity as a fallback.
  (Bug we hit: unconditionally loosening to 1.0 meant "accept almost anything
  within 1000 chars of `loc`", which located a case whose true position was
  1127 at position 8)
- **One span per call by default** — results are sorted by score descending, so
  `out[0]` is always the best hit. Pass `maxMatches` (with `minScore`) for more
- Hits are ultimately gated by the diff score, so relaxing Bitap cannot create
  false positives — but anything below `minScore` is dropped outright
- `diff-match-patch-es` is **ESM-only**; check CJS steps in your build
- The legacy `createDmpFallback` writes `Match_*` as **instance properties**;
  the adapter restores them in a `try/finally`, so sharing one `dmp` instance is
  safe (but note that pre-setting `Match_*` on the instance has no effect — the
  adapter overwrites it; use options instead)
- I/O is **plain string offsets**: no coordinate mapping here

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
