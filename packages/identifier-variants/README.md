# @isdk/identifier-variants

标识符变体归一：TensorFlow ≡ tensor_flow ≡ tensor-flow

## 它解决什么

同一个标识符在不同地方写作不同形式。难点在两个方向的**不对称**：

```
合并 Hello World → HelloWorld   普通词组被并掉      ❌
拆分 HelloWorld  → Hello World  只在缺空格处插入    ✅
```

关键理由：**自然文本里不会出现两个词紧贴无空格**（`thecourt` 不是合法英文），
所以"无空格 + 驼峰"是标识符的强信号；而"有空格 + 驼峰"在标题、人名里到处都是。

同样地，`hello_world` / `hello-world` 的拆分必须限定在**标识符语境**
（两侧都是 `[A-Za-z0-9]`），否则 `北京-上海` 会被并成 `北京上海` ——
那正是第一个问题的镜像。

## 用法

```bash
npm i @isdk/identifier-variants
```

```ts
import { normalizeIdentifier, findIdentifierBreaks } from '@isdk/identifier-variants';

normalizeIdentifier('tensor_flow');  // 'tensor flow'
normalizeIdentifier('TensorFlow');   // 'Tensor Flow'
normalizeIdentifier('北京-上海');     // '北京-上海'（跨脚本不合并）

// 带坐标映射的场景用 findIdentifierBreaks
findIdentifierBreaks('TensorFlow');
// → [{ at: 6, kind: 'insert', sourceLength: 0 }]
findIdentifierBreaks('hello_world');
// → [{ at: 5, kind: 'replace', sourceLength: 1 }]
```

## 边界与取舍

- `Hello World` 也会被当成 `HelloWorld`（同样是驼峰形状）。是否启用取决于你的语料里
  `TensorFlow` 多还是 `Hello World` 多 —— 主包默认**关闭**
- `findIdentifierBreaks` 的存在理由：只导出"最终字符串"的话，高亮/diff 这类带坐标场景
  根本用不了，会导致同一规则被写两遍

## 相关

- 总览：[../../PACKAGES.md](../../PACKAGES.md)
- 英文：README.en.md
