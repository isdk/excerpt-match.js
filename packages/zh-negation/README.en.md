# @isdk/zh-negation

English | [中文](./README.md)

Chinese negation detection (word-boundary aware): 未来/非常/无锡 are not negations

## What it solves

Detecting negation looks like `includes('不')`, but the hard part is
**whether a character is a negation word in that position**:

```
他未来      → not negated (未 is part of a time noun)
他未能到场  → negated
非常高兴    → not negated (content word)
他不去      → negated
不得不去    → not negated (double negation = affirmative)
```

Substring scanning flags 非常, 无锡, 未来, 非洲, 别人 as negations.

**Why similarity cannot catch the opposite** (measured):

```
人工智能在改变世界    score 0.947  equivalent
人工智能没在改变世界  score 0.900  opposite
```

Only 0.047 apart — but "does it have a negation" **is** decidable.

## Usage

```bash
npm i @isdk/zh-negation
```

```ts
import { detectNegation, negationsConflict } from '@isdk/zh-negation';

detectNegation('人工智能没在改变世界').negated;  // true
detectNegation('他不得不去').negated;            // false
detectNegation('非常高兴').negated;              // false
detectNegation("don't know").negated;            // true
detectNegation('他未来', { negations: ['未来'] }).negated; // true
```

## Boundaries and trade-offs

- **Polysemy defaults to conservative**: 未来 takes its frequent sense.
  A miss only loses a guard; a false reject makes valid text wrong — asymmetric.
  Override via `negations`
- **Scope** is not modelled: `他没有说不去` counts as double negation.
  Rare and predictably conservative; not worth a model
- `CONFLICTING_WORDS` self-check: overlap between the two lists makes
  negations **silently dead** (尚未/未必/未曾 once hit this)

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
