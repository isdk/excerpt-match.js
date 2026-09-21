# @isdk/md-flatten

[English](./README.en.md) | 中文

markdown 源码 ↔ 渲染后文本的双向坐标映射

## 它解决什么

md 源码里有大量渲染后不可见的语法：`**`、`#`、`[](url)`、表格的 `|`。
两个坐标系对不上：

```
源码  : 本院**认为**被告构成[根本违约](http://x.com)。
渲染后: 本院认为被告构成根本违约。
                  ↑
            用户复制的是这个，但你要高亮的是源码里的那一段
```

**为什么用 mdast 而不是正则**：mdast 每个节点自带 `position.offset` ——
那就是现成的坐标映射。"什么算渲染后可见"由解析器决定，不用猜；
表格、删除线、脚注、转义这些正则写不对的东西全免费。

用途：评论锚定、引用校验、文档 diff / 冲突标记。

## 用法

```bash
npm i @isdk/md-flatten
```

```ts
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener } from '@isdk/md-flatten';

// GFM 必须同时给语法层与 AST 层，否则表格不解析
const flat = createMdastFlattener(
  (src) => fromMarkdown(src, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
).flatten(md);

flat.text;    // 渲染后可见文本
flat.map[10]; // 第 10 个字符在 md 源码中的下标
```

## 边界与取舍

- 图片 alt **不保留**（渲染成 `<img>`，用户复制不到文字）；链接只留锚文本，URL 丢弃
- 命中 span 回切到源码时**会包含语法标记** —— `length` 是源码长度不是渲染后字数。
  这是必然的，标记就在源码里
- 摘录起止于行内构造**中间**时，「精确」与「独立可渲染」不可兼得。
  本包选精确（`expandToInlineMarkers` 只在完整覆盖内容时补齐标记）
- 摊平结果末尾带块终止符 `
`，比对时记得 `trim()`
- `deriveJoined(flat)` 派生**无分隔符视图**（跨段摘录匹配用）：删掉块间分隔符，
  让块首尾直接相邻。返回值的 `back` 指向**摊平文本**，`blocks` 已换算到
  joined 坐标 —— 但把它再喂给 `normalizeWithMap` 后，得到的 `norm.back`
  指向的仍是**摊平文本**（`j.back` 被复合进去了）。需要「归一化下标 → joined
  raw」必须拿 `j.back` 二分补一跳，直接切 joined 的 `text` 会整体错位

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
