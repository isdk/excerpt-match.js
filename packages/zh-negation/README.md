# @isdk/zh-negation

[English](./README.en.md) | 中文

中文否定检测（词边界感知）：区分「未来/非常/无锡」与真否定词

## 它解决什么

判断一段文本是否含否定，听起来是 `includes('不')`，实际难在
**同一个字在不同位置是不是否定词**：

```
他未来      → 非否定（「未」是时间名词的一部分）
他未能到场  → 否定
非常高兴    → 非否定（实词）
他不去      → 否定
不得不去    → 非否定（双重否定 = 肯定）
```

子串扫描会把 `非常`、`无锡`、`未来`、`非洲`、`别人` 全判成否定。

**为什么相似度拦不住相反语义**（实测）：

```
人工智能在改变世界    score 0.947  ← 等价
人工智能没在改变世界  score 0.900  ← 相反
```

只差 0.047 —— 字符相似度衡量的是"像不像"，而"意思是否一致"是蕴含任务。
但"有没有否定词"是**确定的**。

## 用法

```bash
npm i @isdk/zh-negation
```

```ts
import { detectNegation, negationsConflict } from '@isdk/zh-negation';

detectNegation('人工智能没在改变世界').negated;  // true
detectNegation('他不得不去').negated;            // false（双重否定）
detectNegation('非常高兴').negated;              // false（实词）
detectNegation("don't know").negated;            // true（英文缩写）
detectNegation('他未来').negated;                // false（默认保守）
detectNegation('他未来', { negations: ['未来'] }).negated; // true（领域覆盖）
```

## 边界与取舍

- **多义词默认保守**：`未来` 取高频义（时间名词）。漏判只是少一道守卫，
  误拒是让合法文本彻底判错 —— 代价不对称。要覆盖传 `negations`
- 否定词的**作用域**没建模：`他没有说不去` 会被算成双重否定。结构罕见且行为可预测
  （保守拒绝），不为此上模型
- 内置自检常量 `CONFLICTING_WORDS`：两表若有交集，否定词会**静默失效**
  （`尚未`/`未必`/`未曾` 曾中招）

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
