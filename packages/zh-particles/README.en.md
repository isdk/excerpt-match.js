# @isdk/zh-particles

English | [中文](./README.md)

Chinese particles 的/地/得: tell a particle from part of a content word

## What it solves

Mixing these three is a common typo, but they are **also parts of content words**:

| original | typo | equivalent? |
|---|---|---|
| 他高兴**地**接受 | 他高兴**的**接受 | yes (particle) |
| 辽阔的**大地** | 辽阔的**大的** | no (content word) |
| 他**得到**了批准 | 他**到的**了批准 | no (content word) |

The question is not "is it one of these three characters" but
**"is this character a standalone particle token here"**.
jieba segments 土地 as `土地/n` — the 地 is not a standalone token.

## Usage

```bash
npm i @isdk/zh-particles
```

```ts
import { createGuardListParticleTagger, createJiebaParticleTagger } from '@isdk/zh-particles';

createGuardListParticleTagger().foldableAt('辽阔的大地').has(4); // false

import * as jieba from '@isdk/nlp-jieba';
const tagger = createJiebaParticleTagger(jieba);
tagger.foldableAt('他高兴地接受').has(3); // true
tagger.foldableAt('这片土地').has(3);     // false
```

## Boundaries and trade-offs

- Contract is `foldableAt(text) → ReadonlySet<index>`: **returns all foldable
  indices at once**, so segmentation happens once
- The root package defaults to **no folding** (`ignoreParticles: false`)
- The guard list is a bottomless pit; prefer jieba when you can

## See also

- Overview: [../../PACKAGES.md](../../PACKAGES.md)
- 中文：README.md
