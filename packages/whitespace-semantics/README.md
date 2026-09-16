# @isdk/whitespace-semantics

空白语义：判断两个字符之间的空白**是排版产物，还是承载意义的内容**。

## 它解决什么

删掉一个空格，有时候毫无影响，有时候会改变意思：

```
使用 TensorFlow 框架  ←  使用TensorFlow框架   中文与英文之间：排版产物，可删
the court held       ←  thecourtheld        英文词之间：词分隔符，不可删
아버지가 방에 들어가신다 ← 아버지가방에 들어가신다  韩文：助词归属歧义，不可删
ผู้ซื้อต้อง... ผู้ขายต้อง... ← ผู้ซื้อต้อง...ผู้ขายต้อง...  泰文：句子边界，不可删
```

判据只有一条：**删掉它会不会造成词/语素边界的歧义**。

| 文字 | 用空格分词？ | 删空格的后果 | 角色 |
|---|---|---|---|
| 汉字 / 假名 | 否 | 边界仍清晰 | `ignorable` |
| **韩文** | 是 | 助词归属歧义 → 意思变 | `wordDelimiter` |
| **泰文** | 否（空格表句子） | 丢失句子边界 | `boundary` |
| 拉丁 / 数字 | 是 | `thecourt` ≠ `the court` | `wordDelimiter` |

韩文的关键是**助词依附于前词**：

```
아버지가 방에 들어가신다   （父亲走进房间）
아버지 가방에 들어가신다   （钻进父亲的包里）
```

删掉空格后，同一个音节究竟是前一词的助词还是下一词的开头，彻底无法判断。

泰文结论相同但理由不同：它不用空格分词，空格分的是**句子/短语**，
删掉等价于英文删掉句号 —— 所以归为 `boundary` 而非 `wordDelimiter`。

## 用法

```bash
npm i @isdk/whitespace-semantics
```

```ts
import { canDropSpaceBetween, unicodeScriptOf, WHITESPACE_ROLE_BY_SCRIPT } from '@isdk/whitespace-semantics';

canDropSpaceBetween('han', 'latin');      // true   中文 AI → 中文AI
canDropSpaceBetween('latin', 'latin');    // false  the court
canDropSpaceBetween('hangul', 'hangul');  // false  아버지가 방에
canDropSpaceBetween('thai', 'thai');      // false  泰文句子边界
unicodeScriptOf('あ');                     // 'kana'
WHITESPACE_ROLE_BY_SCRIPT.thai;           // 'boundary'
```

## 命名说明

**不叫 `script-spacing`**：

- `script` 在 JS 语境几乎总指"脚本"，而非"文字系统"（Unicode script）
- `spacing` 暗示排版调整，但本包**只做判断、不改任何东西**

叫 `whitespace-semantics` 是因为它回答的正是语义问题：
**这个空白有没有意义。**

## 边界与取舍

- **只回答"能不能删"，不做字符串改写** —— 归一化由 `@isdk/normalize-text` 负责
- 判据可机械验证：删空格前后跑分词器，结果不一致则该文字的空白载义
- 三种角色（而非布尔）是为了区分"删了会粘连词"与"删了会丢句子边界"，
  两者后果不同，未来若要做差异化处理可以直接扩展

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
