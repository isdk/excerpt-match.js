# @isdk/whitespace-semantics

English | [中文](./README.md)

Whitespace semantics: is the space between two characters **typography, or
meaning-bearing content?**

## What it solves

Sometimes deleting a space changes nothing; sometimes it changes meaning:

```
使用 TensorFlow 框架 ← 使用TensorFlow框架   Han↔Latin: typography, droppable
the court held      ← thecourtheld        Latin↔Latin: word delimiter, keep
아버지가 방에 들어가신다 ← 아버지가방에 들어가신다  Hangul: particle ambiguity, keep
ผู้ซื้อต้อง... ผู้ขายต้อง... ← ...ผู้ขายต้อง...  Thai: sentence boundary, keep
```

One rule: **would deleting it create word/morpheme boundary ambiguity?**

| script | space-delimited? | effect of deleting | role |
|---|---|---|---|
| Han / Kana | no | boundaries stay clear | `ignorable` |
| **Hangul** | yes | particle-attachment ambiguity | `wordDelimiter` |
| **Thai** | no (space marks sentences) | loses sentence boundary | `boundary` |
| Latin / digits | yes | `thecourt` != `the court` | `wordDelimiter` |

Hangul is critical because **particles attach to the preceding word**:

```
아버지가 방에 들어가신다
아버지 가방에 들어가신다
```

Delete the space and you cannot tell whether a syllable is a particle or the
start of the next word.

Thai reaches the same verdict for a different reason: it does not use spaces to
segment words — spaces mark **sentences**, so deleting one is like deleting a
period. Hence `boundary`, not `wordDelimiter`.

## Usage

```bash
npm i @isdk/whitespace-semantics
```

```ts
import { canDropSpaceBetween, unicodeScriptOf, WHITESPACE_ROLE_BY_SCRIPT } from '@isdk/whitespace-semantics';

canDropSpaceBetween('han', 'latin');      // true
canDropSpaceBetween('latin', 'latin');    // false
canDropSpaceBetween('hangul', 'hangul');  // false
canDropSpaceBetween('thai', 'thai');      // false
unicodeScriptOf('\u3042');                 // 'kana'
WHITESPACE_ROLE_BY_SCRIPT.thai;           // 'boundary'
```

## Why not `script-spacing`

- `script` in a JS context almost always means "script file", not "writing
  system" (Unicode script)
- `spacing` implies typesetting adjustments, but this package **only decides,
  it never rewrites**

`whitespace-semantics` names the actual question: **does this whitespace carry
meaning?**

## Boundaries and trade-offs

- **It answers "may this be dropped"; rewriting is `@isdk/normalize-text`'s job**
- The rule is mechanically checkable: segment before/after deletion; if results
  differ, the whitespace carries meaning
- Three roles instead of a boolean, because "glues two words together" and
  "loses a sentence boundary" have different consequences

## See also

- Overview: [../../PACKAGES.en.md](../../PACKAGES.en.md)
- 中文：README.md
