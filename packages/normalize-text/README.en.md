# @isdk/normalize-text

Normalize while keeping source coordinates: highlighting, citation, diff

## What it solves

Normalization is common, but existing helpers (`toLowerCase`, NFKC,
various cleaners) share one trait: **they return the string, not the map**.

So "highlight the search hit", "locate the citation", "annotate a diff"
are all impossible — you cannot map character i back to the source.

`normalizeWithMap` returns `map` / `mapEnd` / `back` so coordinates round-trip.

## Usage

```bash
npm i @isdk/normalize-text
```

```ts
import { normalizeWithMap } from '@isdk/normalize-text';

const src = '第 1，000 条 和 TensorFlow';
const r = normalizeWithMap(src, { ignorePunctuation: true });
r.text;
r.map[2]; // index in the original string
```

## Boundaries and trade-offs

**Four stages; the order is a contract**:

```
1. foldWidth          NFKC + zero-width removal
2. normalizeNumbers   number notation
3. foldCase           case
4. foldPunctAndSpace  punctuation / particles / whitespace
```

Numbers must be **2**: after NFKC (Chinese docs use fullwidth `1，000`,
which is `，` not `,` before NFKC) and before punctuation folding
(、 is not folded by NFKC, so only here can you tell `1,000` from `1、000`).

Also:
- `mapEnd` **cannot be derived from `map[i+1]`**: escapes (`\*`) and entities
  (`&amp;`) make one visible char span several source chars
- `back` must **compose across stages**
- Number notation is not a separate package: it is position-sensitive

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
