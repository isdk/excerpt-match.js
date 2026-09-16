# @isdk/identifier-variants

Identifier variant normalization: TensorFlow ≡ tensor_flow ≡ tensor-flow

## What it solves

Two directions look symmetric but are not:

```
join  Hello World → HelloWorld   an ordinary phrase gets glued   ❌
split HelloWorld  → Hello World  only inserts where absent       ✅
```

**Natural text never has two words with no space** (`thecourt` is not
English), so "no space + camelCase" is a strong identifier signal,
while "space + camelCase" is everywhere in titles and names.

Likewise, splitting `hello_world` / `hello-world` must be restricted to
**identifier context** (both neighbors `[A-Za-z0-9]`), or `北京-上海`
would glue into `北京上海`.

## Usage

```bash
npm i @isdk/identifier-variants
```

```ts
import { normalizeIdentifier, findIdentifierBreaks } from '@isdk/identifier-variants';

normalizeIdentifier('tensor_flow');  // 'tensor flow'
normalizeIdentifier('TensorFlow');   // 'Tensor Flow'

// For coordinate-mapping scenarios
findIdentifierBreaks('TensorFlow');
// → [{ at: 6, kind: 'insert', sourceLength: 0 }]
```

## Boundaries and trade-offs

- `Hello World` also matches (same camel shape). Whether to enable depends on your
  corpus; the root package defaults to **off**
- `findIdentifierBreaks` exists because exporting only the final string makes
  coordinate-carrying scenarios (highlight/diff) duplicate the rule

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
