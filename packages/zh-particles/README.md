# @isdk/zh-particles

中文结构助词「的/地/得」判定：区分助词与实词

## 它解决什么

这三个字混用确实是常见错别字，但它们**同时也是实词的一部分**：

| 原文 | 误用后 | 是否等价 |
|---|---|---|
| 他高兴**地**接受 | 他高兴**的**接受 | ✅ 是（助词） |
| 辽阔的**大地** | 辽阔的**大的** | ❌ 否（实词） |
| 他**得到**了批准 | 他**到的**了批准 | ❌ 否（实词） |

所以判定的关键不是"是不是这三个字"，而是**"此处的字是不是独立的助词 token"**。
jieba 把「土地」切成 `土地/n`，里面的「地」根本不是独立 token，自然不会被折叠。

## 用法

```bash
npm i @isdk/zh-particles
```

```ts
import { createGuardListParticleTagger, createJiebaParticleTagger } from '@isdk/zh-particles';

// 零依赖保守模式（实词保护表）
createGuardListParticleTagger().foldableAt('辽阔的大地').has(4); // false

// 精确模式：注入 jieba
import * as jieba from '@isdk/nlp-jieba';
const tagger = createJiebaParticleTagger(jieba);
tagger.foldableAt('他高兴地接受').has(3); // true（助词）
tagger.foldableAt('这片土地').has(3);     // false（实词）
```

## 边界与取舍

- 契约是 `foldableAt(text) → ReadonlySet<下标>`，**一次性返回可折叠下标集合**，
  只需分词一次而非每位置各分一次
- 主包默认**不折叠**（`ignoreParticles: false`）：误判代价高于漏判
- 保护表是无底洞（大地/土地/得到/值得/懂得…），能引 jieba 就引

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
