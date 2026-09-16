# @isdk/semantic-locate

两阶段语义定位：外部召回候选段 → 段内精确对齐到字符下标

## 它解决什么

语义检索（embedding / BM25）能告诉你"大概是这一段"，但**给不出精确字符下标**。
直接让模型吐下标呢？**不行** —— LLM / embedding 返回的下标在长文里经常漂
（token ≠ 字符），不同 tokenizer 口径还不一致。

所以拆两段：**召回只回答"哪一段"，精确定位是确定性问题。**

### score 的两种语义（重要）

| 来源 | 语义 | 上界 |
|---|---|---|
| BM25 | 相关性**排序分** | **无界** |
| 余弦相似度 | 方向相似度 | -1~1 |
| 对齐（编辑距离类） | **绝对**相似度 | 0~1 |

- `via: 'aligned'` → `score` 是**对齐分**，绝对、跨查询可比，可做阈值决策
- `via: 'segment'` → `score` 是归一化召回分，**仅排序意义**
- `recallRank` 是唯一跨检索器实现都可比的指标

拿 BM25 的 `12.5` 与对齐的 `0.87` 做 `Math.min` 是错的 ——
它假设两者同量纲；钳到 `[0,1]` 更糟，那把相对分**伪装成**绝对分。

## 用法

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

## 边界与取舍

- **不算向量** —— 检索器由调用方注入（embedding / BM25 都行）
- **不做段内对齐算法** —— 用 `@isdk/approx-text-match`
- 没有 `aligner` 或对齐失败时**降级为整段并降分**（×0.9），不返回 null：
  给用户粗粒度位置比什么都不给有用
- `minRecallScore` 对 BM25 **无意义**（无上界），请改用 `topK` 截断

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
