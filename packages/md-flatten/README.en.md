# @isdk/md-flatten

Bidirectional coordinate mapping between markdown source and rendered text

## What it solves

Markdown contains syntax that is invisible after rendering:
`**`, `#`, `[](url)`, table pipes. Two coordinate systems do not line up:

```
source : 本院**认为**被告构成[根本违约](http://x.com)。
rendered: 本院认为被告构成根本违约。
                  ↑
          the user copies this, but you must highlight that span in source
```

**Why mdast, not regex**: every node carries `position.offset` —
a ready-made coordinate map. What counts as visible is decided by the parser,
not guessed; tables, strikethrough, footnotes, escapes all come free.

Uses: comment anchoring, citation checking, document diff.

## Usage

```bash
npm i @isdk/md-flatten
```

```ts
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener } from '@isdk/md-flatten';

const flat = createMdastFlattener(
  (src) => fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
).flatten(md);

flat.text;
flat.map[10];
```

## Boundaries and trade-offs

- Image alt is **dropped** (renders to `<img>`); links keep anchor text, URL dropped
- A span mapped back to source **includes the syntax markers** — `length` is the
  source length, not the rendered count
- When an excerpt starts/ends **inside** an inline construct, exactness and
  standalone renderability cannot both hold; this package chooses exactness
- Flattened text ends with a block terminator `\n`; `trim()` when comparing
- `deriveJoined(flat)` derives a **separator-free view** (for cross-paragraph
  excerpt matching): block separators are removed so blocks sit flush against
  each other. Its `back` points into the **flattened text**, and `blocks` are
  already rebased to joined coordinates — but feed the result to
  `normalizeWithMap` and the resulting `norm.back` still points into the
  **flattened text** (`j.back` gets composed in). To map a normalized index to
  joined raw you must bisect through `j.back` for one extra hop; slicing the
  joined `text` with the normalized `back` directly is uniformly off by the
  number of separators stripped so far

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
