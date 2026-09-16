# @isdk/approx-text-match

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

1. **seed-and-extend** — Bitap degrades on long patterns; pick the seed that
   occurs fewest times, locate it, then open a window
2. **Span boundary** — `match_main` returns **a start but no length**;
   refine the end via diff

jsdiff is excluded not for quality but for capability: no fuzzy locating.

## Usage

```bash
npm i @isdk/approx-text-match
```

```ts
import * as dmp from 'diff-match-patch-es';
import { createDmpEsFallback } from '@isdk/approx-text-match';

const find = createDmpEsFallback(dmp);
find.find('本院认为被告的行为构成根本违约', '本院认为，被告的行为已经构成根本违约，应当赔偿。');
// → [{ start: 0, end: 18, score: 0.909 }]
```

## Boundaries and trade-offs

- **Do not pass `threshold` by default** — the es build is more sensitive;
  `{threshold: 0.4}` made hits that previously worked return `-1`
- `diff-match-patch-es` is **ESM-only**; check CJS steps in your build
- I/O is **plain string offsets**: no coordinate mapping here

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
