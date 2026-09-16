# @isdk/normalize-text

归一化并保留原文坐标映射：搜索高亮、引用定位、文本 diff 都需要

## 它解决什么

字符串归一化是常见需求，但现成库（`toLowerCase`、NFKC、各种 cleaner）
有一个共同点：**只给归一化后的字符串，不给坐标映射**。

于是"高亮搜索结果""定位引用出处""给 diff 标位置"全都做不了 ——
你找不到归一化串里第 i 个字符对应原文的哪里。

`normalizeWithMap` 返回 `map` / `mapEnd` / `back` 三张表，保证坐标可来回换算。

## 用法

```bash
npm i @isdk/normalize-text
```

```ts
import { normalizeWithMap } from '@isdk/normalize-text';

const src = '第 1，000 条 和 TensorFlow';
const r = normalizeWithMap(src, { ignorePunctuation: true });
r.text;   // 归一化后文本
r.map[2]; // 第 2 个字符在原文中的下标
```

## 边界与取舍

**四个阶段，顺序是契约**：

```
1. foldWidth          NFKC + 零宽字符剔除
2. normalizeNumbers   数字记法
3. foldCase           大小写
4. foldPunctAndSpace  标点 / 助词 / 空白
```

数字必须在 **2**：在 NFKC 之后（中文文档千分位多是全角 `1，000`，NFKC 前是 `，`
不是 `,`），在标点折叠之前（顿号 `、` 不被 NFKC 折叠，早于此才能区分
`1,000` 与 `1、000`）。

其他要点：
- `mapEnd` **不可由 `map[i+1]` 推算**：转义（`\*` → `*`）与实体（`&amp;` → `&`）
  会让一个可见字符横跨多个源码字符
- `back` 必须**跨阶段复合** —— 每个阶段只知道"指向本阶段输入"
- 数字记法没有独立成包：它位置敏感，独立出去容易放错位置

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
