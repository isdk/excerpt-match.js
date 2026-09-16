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

### 不变量

```
src.slice(map[0], mapEnd[len-1])  再归一化  ===  text      ← 整段
```

- 幂等：`normalize(normalize(x)) === normalize(x)`
- `map` 单调不减，且 `map.length === text.length + 1`（末尾哨兵保证 `map[len]` 有定义）

注意说的是**整段**，不是"任意第 i 个字符"：NFKC 展开（`ﬁ` → `fi`）让多个输出字符
**共享**同一个源码区间，单个字符会回切到整个展开。这是刻意的保守行为
（宁可多切，不可切漏）。

这些不变量由 **属性测试**（`fast-check`，随机文本 × 随机选项）守护，
不是几个手写用例 —— 代理对（Emoji / CJK 扩展 B）相关的坐标 bug 就是它跑出来的。

其他要点：
- `mapEnd` **不可由 `map[i+1]` 推算**：转义（`\*` → `*`）与实体（`&amp;` → `&`）
  会让一个可见字符横跨多个源码字符
- 索引口径是 **UTF-16 code unit**，但 `mapEnd` 按**字符**给：
  代理对占 2 个 unit，写成 `i+1` 会切出半个代理项
- `back` 必须**跨阶段复合** —— 每个阶段只知道"指向本阶段输入"
- 数字记法没有独立成包：它位置敏感，独立出去容易放错位置

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
