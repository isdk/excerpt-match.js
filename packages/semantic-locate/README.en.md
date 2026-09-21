# @isdk/semantic-locate

English | [中文](./README.md)

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

const hit = await locateSemantic(text, excerpt, myRetriever, {
  aligner: (ex, seg, segStart) => approxFind.find(ex, seg)?.[0] ?? null,
  checkPolarity: true,
});
// → { start: 120, end: 158, score: 0.87, via: 'aligned', recallRank: 0 }
```

### The third `SegmentAligner` argument

```ts
type SegmentAligner = (
  excerpt: string,
  segmentText: string,
  segmentStart: number   // where this segment starts in the input text
) => { start: number; end: number; score: number } | null;
```

**`segmentStart` exists for callers to convert coordinates**: this package returns
in-segment offsets, so converting them to whole-page coordinates requires knowing
where the segment starts. **Do not reverse-lookup with `indexOf`** — duplicated
segments would resolve to the first one and the coordinates would be wrong.

It is an **appended** parameter: implementations that declare only two parameters
still work (TypeScript allows fewer parameters than the caller passes).

### Retriever context

`locale` and `tokenize` are passed through to the retriever verbatim (BM25 and
multilingual models need them). This package **does not detect the language** —
that is the caller's job.

```ts
const hit = await locateSemantic(text, excerpt, myRetriever, {
  locale: 'zh',
  tokenize: (t) => Array.from(t),
  aligner: myAligner,
});
```

## Boundaries and trade-offs

- **No vector computation** — inject your retriever (embedding or BM25)
- **No alignment algorithm** — use `@isdk/approx-text-match`
- With no `aligner` (or failed alignment) it **degrades to the whole segment
  with a penalty** (×0.9) rather than null: a coarse position beats none
- **`topK` really means it**: the top K candidates are each **tried in turn**, and
  only if all fail does it degrade to the whole segment. Retrieval only ranks —
  the top-ranked segment is not necessarily the one that aligns precisely
- `minRecallScore` is **meaningless for BM25** (unbounded); use `topK`

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
