# @isdk/semantic-locate

Two-stage semantic locating: retrieve a segment, then align to exact offsets

## What it solves

Semantic retrieval (embedding / BM25) tells you "roughly this segment"
but **cannot give exact character offsets**. Asking the model for offsets
does not work either: LLM/embedding offsets drift in long documents
(token ≠ character), and tokenizers disagree.

So split it: **retrieval answers "which segment"; precise location is a
deterministic problem.**

### Two meanings of `score`

| source | meaning | bound |
|---|---|---|
| BM25 | **ranking** relevance | **unbounded** |
| cosine | directional similarity | -1~1 |
| alignment (edit-distance) | **absolute** similarity | 0~1 |

- `via: 'aligned'` → `score` is the **alignment** score: absolute, comparable
- `via: 'segment'` → `score` is a normalized recall score: **ordering only**
- `recallRank` is the only cross-implementation comparable metric

`Math.min` of BM25's `12.5` and an alignment `0.87` is wrong — it assumes a
shared scale; clamping to `[0,1]` is worse, it disguises a relative score
as an absolute one.

## Usage

```bash
npm i @isdk/semantic-locate
```

```ts
import { locateSemantic } from '@isdk/semantic-locate';

const hit = await locateSemantic(page, excerpt, myRetriever, {
  aligner: (ex, seg) => approxFind.find(ex, seg)?.[0] ?? null,
  checkPolarity: true,
});
// → { start: 120, end: 158, score: 0.87, via: 'aligned', recallRank: 0 }
```

## Boundaries and trade-offs

- **No vector computation** — inject your retriever (embedding or BM25)
- **No alignment algorithm** — use `@isdk/approx-text-match`
- With no `aligner` (or failed alignment) it **degrades to the whole segment
  with a penalty** (×0.9) rather than null: a coarse position beats none
- `minRecallScore` is **meaningless for BM25** (unbounded); use `topK`

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
