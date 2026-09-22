# @isdk/approx-text-match

[English](./README.en.md) | 中文

近似子串定位：在长文本里找出最相似的连续区间 + 相似度

## 它解决什么

**和模糊搜索库的区别**：

| | 模糊搜索（Fuse / fuzzysort / SymSpell） | 本包 |
|---|---|---|
| 回答 | 哪些字符匹配上了 | 命中**哪一段** |
| 输出 | 分散的匹配下标 | `{ start, end, score }` |

前者推不出后者：模糊搜索**跳过**的不匹配字符（如标点）
在区间语义里**必须被包含**，否则高亮会缺字。

**不重复发明轮子**：比对算法用现成库。本包只做两件库不管的事：

1. **seed-and-extend** —— Bitap 对长 pattern 有上限，先挑"页面中出现次数最少"的
   种子定位，再开窗精修。种子挑选会避开**毒化种子**：摘录混着文档侧不存在
   的字符时（md 标记 `**`、被压坏的列表序号、OCR 噪声……），含它们的窗口在
   原文里出现 0 次。「出现 0 次」不是「最稀有」—— 根本不存在的种子只会让
   Bitap 空手而归；只有「稀有但存在」的才是锚点。
2. **区间边界确定** —— `match_main` **只返回起始位置不给长度**，靠 diff 精修

jsdiff 被排除不是因为它不好，而是它只有全量比对，做不了模糊定位。

## 用法

```bash
npm i @isdk/approx-text-match
```

```ts
import * as dmp from 'diff-match-patch-es';
import { createDmpEsFallback } from '@isdk/approx-text-match';

const find = createDmpEsFallback(dmp);
find.find('本院认为被告的行为构成根本违约', '本院认为，被告的行为已经构成根本违约，应当赔偿。');
// → [{ start: 0, end: 18, score: 0.909 }]
```

## 边界与取舍

- **默认不要传 `threshold`** —— es 版对阈值更敏感，传 `{threshold: 0.4}`
  会让原本能命中的摘录失效（实测 `-1`）。内部在 Bitap 返回 -1 时会**放宽重试**
  （先放宽阈值、再摘掉 proximity 惩罚）：毒化种子找不到精确落点时 `loc` 退化
  为 0，`|loc - 真实位置| / matchDistance` 这条惩罚完全是坏位置估计的产物，
  会压过默认阈值。放宽 Bitap 不影响质量 —— 命中与否最终由 diff 分数把关
- `diff-match-patch-es` 是**纯 ESM**，构建链有 CJS 环节要先确认
- 输入输出都是**纯字符串下标**：本包不关心坐标映射，只回答"哪一段最像"

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
