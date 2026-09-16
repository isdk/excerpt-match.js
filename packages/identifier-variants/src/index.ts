/**
 * `@isdk/identifier-variants` —— 标识符变体归一。
 *
 * 同一个标识符在不同地方写作不同形式，检索时应当等价：
 *
 * ```
 * TensorFlow ≡ tensor_flow ≡ tensor-flow ≡ tensor flow
 * ```
 *
 * ## 方向：拆分而非合并
 *
 * 两个方向看似对称，误判面完全不同：
 *
 * ```
 * 合并 Hello World → HelloWorld   普通词组被并掉      ❌
 * 拆分 HelloWorld  → Hello World  只在缺空格处插入    ✅
 * ```
 *
 * 关键不对称：**自然文本里不会出现两个词紧贴无空格**（`thecourt` 不是合法英文），
 * 所以「无空格 + 驼峰」是标识符的强信号；而「有空格 + 驼峰」在标题、人名里到处都是。
 *
 * ## 带坐标映射的场景
 *
 * 用 {@link findIdentifierBreaks} 而非 {@link normalizeIdentifier} ——
 * 它返回**待插入位置与类型**，调用方据此维护自己的下标映射。
 *
 * @packageDocumentation
 */

export {
  findIdentifierBreaks,
  normalizeIdentifier,
  normalizeSeparators,
  splitCamelCase,
} from './identifierVariants';
export type { IdentifierBreak, Separator } from './identifierVariants';
