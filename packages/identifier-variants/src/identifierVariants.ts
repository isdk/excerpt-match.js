/**
 * 标识符变体归一 —— `TensorFlow` / `tensor_flow` / `tensor-flow` / `Tensor Flow` → 同一形式。
 *
 * @remarks
 * 常见场景：代码搜索、文档检索、日志聚合 —— 同一个标识符在不同地方
 * 写作不同形式，检索时应当等价。
 *
 * 方向选择：**拆分而非合并**（`TensorFlow` → `Tensor Flow`）。
 * 理由是不对称性 —— 自然文本里不会出现两个词紧贴无空格
 * （`thecourt` 不是合法英文），所以「无空格 + 驼峰」是标识符的强信号；
 * 而「有空格 + 驼峰」在标题、人名里到处都是（`Hello World`）。
 * 两个方向看似对称，误判面完全不同。
 *
 * @example
 * ```ts
 * splitCamelCase("TensorFlow");          // "Tensor Flow"
 * normalizeIdentifier("hello_world");    // "hello world"
 * normalizeIdentifier("hello-world");    // "hello world"
 * ```
 *
 * @packageDocumentation
 */

/** 标识符内部字符：只有两侧都是它时，才认为处于「标识符语境」 */
const IDENTIFIER_CHAR_PATTERN = /[A-Za-z0-9]/;
const UPPERCASE_PATTERN = /[A-Z]/;
const LOWERCASE_OR_DIGIT_PATTERN = /[a-z0-9]/;

/**
 * 各类连字符。NFKC 不折叠 `–`（en dash），所以这里要显式列出。
 *
 * @remarks
 * 只在**两侧都是标识符字符**时才把它们当分隔符 ——
 * 否则 `北京-上海` 会被并成 `北京上海`，`第3-5条` 会变成 `第35条`。
 */
const DASH_CHARACTERS = new Set(['-', '‐', '‑', '‒', '–', '—', '―', '−']);

/**
 * 插入分隔空格时使用的字符。
 *
 * @remarks
 * 默认是空格。但归一化流水线里应当传「折叠占位符」——
 * 因为后续阶段会把所有空白折叠成同一个占位符，直接插空格会
 * 让标识符内部的分隔与真实词间空白混在一起。
 */
export type Separator = string;

/**
 * 找出所有应当插入分隔符的位置（下标 = 插入点，即 `text.slice(0, at)` 之后）。
 *
 * @remarks
 * **这是本包的核心抽象**，纯字符串函数与带坐标映射的场景共享它：
 * - 只要归一化文本 → 用 {@link normalizeIdentifier}
 * - 还要保留原文坐标（如高亮、diff）→ 拿这些位置自己维护映射，
 *   插入的字符宽度记为 0（指向原位置），见 {@link IdentifierBreak}。
 *
 * 这样避免了「同一个判定逻辑写两遍」。
 *
 * @param splitCamel 是否拆分驼峰（`TensorFlow` → `Tensor Flow`）
 * @param unifySeparators 是否把 `_` / 连字符统一成分隔符
 */
export function findIdentifierBreaks(
  text: string,
  options: { splitCamel?: boolean; unifySeparators?: boolean } = {}
): IdentifierBreak[] {
  const splitCamel = options.splitCamel ?? true;
  const unify = options.unifySeparators ?? true;
  const out: IdentifierBreak[] = [];
  for (let i = 0; i < text.length; i++) {
    const cur = text[i];
    if (unify && (cur === '_' || DASH_CHARACTERS.has(cur))) {
      const prev = i > 0 ? text[i - 1] : '';
      const next = i + 1 < text.length ? text[i + 1] : '';
      // 必须两侧都是标识符字符，否则「北京-上海」「第3-5条」会被错误合并
      if (IDENTIFIER_CHAR_PATTERN.test(prev) && IDENTIFIER_CHAR_PATTERN.test(next)) {
        out.push({ at: i, kind: 'replace', sourceLength: 1 });
      }
      continue;
    }
    if (splitCamel && i > 0) {
      const prev = text[i - 1];
      if (LOWERCASE_OR_DIGIT_PATTERN.test(prev) && UPPERCASE_PATTERN.test(cur)) {
        out.push({ at: i, kind: 'insert', sourceLength: 0 });
      }
    }
  }
  return out;
}

/** 一处需要插入分隔符的位置 */
export interface IdentifierBreak {
  /** 插入点：`text.slice(0, at)` 之后 */
  at: number;
  /**
   * `replace` = 该位置的原字符被替换成分隔符（占 1 个源字符）；
   * `insert` = 纯插入，不消耗源字符（宽度为 0）
   */
  kind: 'replace' | 'insert';
  /** 消耗的源字符数，供坐标映射使用 */
  sourceLength: number;
}

/** `TensorFlow` → `Tensor Flow`：在小写/数字接大写的驼峰边界插入分隔符 */
/** 把 {@link IdentifierBreak} 应用到文本上 */
function applyBreaks(text: string, breaks: IdentifierBreak[], separator: Separator): string {
  const at = new Map(breaks.map((b) => [b.at, b]));
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const b = at.get(i);
    if (b) {
      out += separator;
      if (b.kind === 'replace') continue; // 原字符被吃掉
    }
    out += text[i];
  }
  return out;
}

export function splitCamelCase(text: string, separator: Separator = ' '): string {
  return applyBreaks(text, findIdentifierBreaks(text, { splitCamel: true, unifySeparators: false }), separator);
}

/**
 * 把 `_` 与各类连字符统一成空格（仅在标识符语境内）。
 *
 * @remarks
 * 必须限定两侧都是 `[A-Za-z0-9]`，否则会把 `北京-上海` 并成 `北京上海`。
 */
export function normalizeSeparators(text: string, separator: Separator = ' '): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const cur = text[i];
    if (cur === "_" || DASH_CHARACTERS.has(cur)) {
      const prev = i > 0 ? text[i - 1] : "";
      const next = i + 1 < text.length ? text[i + 1] : "";
      if (IDENTIFIER_CHAR_PATTERN.test(prev) && IDENTIFIER_CHAR_PATTERN.test(next)) {
        out += separator;
        continue;
      }
    }
    out += cur;
  }
  return out;
}

/**
 * 完整归一：先统一分隔符，再拆分驼峰。
 *
 * @example
 * ```ts
 * normalizeIdentifier("hello_world");  // "hello world"
 * normalizeIdentifier("HelloWorld");   // "Hello World"
 * normalizeIdentifier("tensor-flow");  // "tensor flow"
 * ```
 */
export function normalizeIdentifier(text: string, separator: Separator = ' '): string {
  return splitCamelCase(normalizeSeparators(text, separator), separator);
}
