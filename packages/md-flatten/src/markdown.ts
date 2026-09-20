/**
 * Markdown 摊平 —— md 源码 →「渲染后可见文本」+ **精确**源码坐标。
 *
 * 前提：text 是 md 源码，摘录来自渲染后的文档。中间隔着一层渲染：
 *
 *   md   : 本院**认为**被告构成[根本违约](http://x.com)。
 *   页面 : 本院认为被告构成根本违约。
 *
 * 契约：返回的 index / length 是 **md 源码中的精确位置与长度**，
 * 即 mdSource.slice(index, index + length) 就是命中的源码片段。
 *
 * 为此每个字符存两份坐标：
 *   map[i]    = 该字符在 md 源码中的起始下标
 *   mapEnd[i] = 该字符在 md 源码中的结束下标（不含）
 * 二者不可互相推算 —— 转义（\* → *）与实体（&amp; → &）会让一个可见字符
 * 对应多个源码字符。
 */

import type { NormalizedText } from '@isdk/normalize-text';



/** 块级切片（段落 / 标题 / 表格 / 代码块…） */
export interface FlatBlock {
  /** 在可见文本中的起始下标 */
  start: number;
  /** 在可见文本中的结束下标 */
  end: number;
  /** 在 md 源码中的起始下标 */
  srcStart: number;
  /** 在 md 源码中的结束下标 */
  srcEnd: number;
}

/** 行内构造（加粗 / 斜体 / 链接 / 行内码…）在 md 源码中的位置 */
export interface InlineConstruct {
  /** 整个构造（含标记）的源码起始下标，如 `**被告**` 的 `**` 处 */
  start: number;
  /** 整个构造的源码结束下标 */
  end: number;
  /** 内容区间起点（去掉开始标记后），如 `**被告**` 的「被」处 */
  contentStart: number;
  /** 内容区间终点（去掉结束标记后） */
  contentEnd: number;
  /** 外层构造在 `constructs` 数组中的下标，-1 表示无外层 */
  parent: number;
}

/** {@link MarkdownFlattener.flatten} 的返回值 */
export interface FlatResult extends NormalizedText {
  /** 块级切片，坐标系与 `text` 一致 */
  blocks: FlatBlock[];
  /** `inl[i]` = 第 i 个字符所属的最内层行内构造下标，-1 表示无 */
  inl?: number[];
  /** 行内构造列表 */
  constructs?: InlineConstruct[];
  /**
   * `isSep[i]` = 第 i 个字符是否是块间分隔符。
   * 这些字符是我们插入的排版产物，跨块匹配时会被跳过。
   */
  isSep?: boolean[];
}

export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

export type FromMarkdown = (src: string, options?: Record<string, unknown>) => MdNode;

/** {@link createMdastFlattener} 的选项 */
export interface MdastOptions {
  /**
   * micromark **语法**扩展，例如 `micromark-extension-gfm` 的 `gfm()`。
   *
   * @remarks
   * 注意与 `mdastExtensions` 是两个包：`mdast-util-gfm` 只提供 mdast 侧，
   * `micromark-extension-gfm` 才提供语法侧。只装前者的话表格不会被解析成 `table` 节点。
   */
  extensions?: unknown[];
  /** mdast 扩展，例如 `mdast-util-gfm` 的 `gfmFromMarkdown()` */
  mdastExtensions?: unknown[];
  /**
   * 块之间的分隔符。
   * @defaultValue `'\n'` —— 宽容，允许摘录跨块
   */
  blockSeparator?: string;
}

export interface MarkdownFlattener {
  flatten(src: string): FlatResult;
}

/** front matter：不加 remark-frontmatter 时会被当成 hr + 标题，污染文本，手动跳过 */
const FRONT_MATTER_RE = /^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)\r?\n?/;

const ESCAPABLE = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
const ENTITY_RE = /^(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});/;

/**
 * 命名实体解码表。
 *
 * @remarks
 * 只列 CommonMark 实际会解码的这五个（数值实体 `&#39;` / `&#x27;` 无需查表）。
 * micromark 支持完整的 HTML 实体表，但那些生僻字形罕见，缺了它们只是退回「整体跳过」，
 * 不会像坐标错位那样污染后续所有字符。
 */
const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/**
 * 读取 p 处的实体引用。
 *
 * @returns `null` = 这里不是实体；`value` 为空串 = 是实体但不认识，调用方应整体跳过
 */
function readEntity(src: string, p: number, end: number): { value: string; endPos: number } | null {
  const m = ENTITY_RE.exec(src.slice(p + 1, Math.min(end, p + 40)));
  if (!m) return null;
  const name = m[0].slice(0, -1); // 去掉末尾的 ';'
  let value = '';
  if (name.charCodeAt(0) === 35 /* '#' */) {
    const isHex = name[1] === 'x' || name[1] === 'X';
    const cp = parseInt(isHex ? name.slice(2) : name.slice(1), isHex ? 16 : 10);
    if (Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff) value = String.fromCodePoint(cp);
  } else {
    value = NAMED_ENTITIES[name] ?? '';
  }
  return { value, endPos: Math.min(end, p + 1 + m[0].length) };
}

/** `\X` 是否是一个转义序列 */
function isEscapeAt(src: string, p: number, end: number): boolean {
  return src[p] === '\\' && p + 1 < end && ESCAPABLE.includes(src[p + 1]);
}

/**
 * 跳过转义符 / 实体 / CR，把源码指针 p 对齐到字符 ch。
 *
 * @remarks
 * 关键细节：转义与实体**可能生成的正是 ch 本身** —— `\*` 渲染成 `*`、
 * `&gt;` 渲染成 `>`。若在跳过前不先比对，找目标字符时就会越过它一路跑到文末，
 * 于是该字符起的所有坐标级联塌陷。`&amp;` 之所以历来正常，只是因为实体的首字符
 * 恰好就是 '&'，与第一个分支撞上了而已。
 */
function alignTo(src: string, p: number, end: number, ch: string): number {
  // 一律用 startsWith 比对：`ch` 可能是代理对（emoji、扩展汉字），
  // 按 code unit 逐个比永远比不上，坐标会连带塌到段末
  while (p < end) {
    if (src.startsWith(ch, p)) return p;
    if (isEscapeAt(src, p, end)) {
      if (src.startsWith(ch, p + 1)) return p; // 这个转义产生的就是要找的字符
      p += 2;
      continue;
    }
    if (src[p] === '&') {
      const ent = readEntity(src, p, end);
      if (ent) {
        if (ent.value.startsWith(ch)) return p; // 这个实体解码出的首字符就是要找的字符
        p = ent.endPos;
        continue;
      }
    }
    if (src[p] === '\r') {
      p += 1;
      continue;
    }
    p += 1;
  }
  return p;
}

/**
 * 该位置字符的源码结束位置（不含）。
 *
 * @remarks
 * 转义字符占**两个**源码字符（`\*`），实体占整个引用（`&gt;`），
 * 代理对占两个 code unit —— 一个可见字符横跨多个源码字符，
 * 正是这里唯一需要留心的事。
 */
function charEnd(src: string, p: number, end: number): number {
  if (p >= end) return p;
  if (isEscapeAt(src, p, end)) return Math.min(end, p + 2);
  if (src[p] === '&') {
    const ent = readEntity(src, p, end);
    if (ent) return ent.endPos;
  }
  const cp = src.codePointAt(p);
  return Math.min(end, p + (cp !== undefined && cp > 0xffff ? 2 : 1));
}

const SKIP_TYPES = new Set([
  'image', 'imageReference', 'html', 'thematicBreak', 'definition',
  'footnoteDefinition', 'yaml', 'toml',
]);
/** 记录为独立块的节点类型 */
const BLOCK_TYPES = new Set(['paragraph', 'heading', 'code', 'table']);
/** 带行内标记、需要参与 span 扩展的节点类型 */
const INLINE_TYPES = new Set(['strong', 'emphasis', 'delete', 'inlineCode', 'link', 'linkReference']);

/**
 * 用 mdast 把 md 源码摊平成「渲染后可见文本」+ 精确源码坐标。
 *
 * **为什么用 mdast 而不是正则**：
 * - 每个节点自带 `position.offset`，天然就是我们要的下标映射
 * - 「什么算渲染后可见」由解析器决定，不用猜
 * - 表格、删除线、脚注、转义这些正则写不对的东西都免费
 *
 * **几个反直觉但正确的取舍**：
 * - 图片的 alt **不**保留（渲染成 `<img>`，用户复制不到文字）
 * - 链接只留锚文本，URL 丢弃
 * - front matter、HTML 残留、注释、表格 `|`、标题 `#` 全部丢弃
 * - 转义（`\*` → `*`）与实体（`&amp;` → `&`）逐个处理；
 *   否则第一次遇到转义后，后面所有字符的坐标都会级联错位
 *
 * @param fromMarkdown `mdast-util-from-markdown` 的 `fromMarkdown`（依赖注入，核心保持零依赖）
 * @param options 扩展与分隔符配置
 * @returns 摊平器
 *
 * @example
 * ```ts
 * import { fromMarkdown } from 'mdast-util-from-markdown';
 * import { gfm } from 'micromark-extension-gfm';
 * import { gfmFromMarkdown } from 'mdast-util-gfm';
 *
 * const md = createMdastFlattener(fromMarkdown, {
 *   extensions: [gfm()],
 *   mdastExtensions: [gfmFromMarkdown()],
 * });
 * ```
 */
export function createMdastFlattener(fromMarkdown: FromMarkdown, options: MdastOptions = {}): MarkdownFlattener {
  const sep = options.blockSeparator ?? '\n';

  return {
    flatten(src: string): FlatResult {
      const fm = FRONT_MATTER_RE.exec(src);
      const skip = fm ? fm[0].length : 0;
      const body = skip > 0 ? src.slice(skip) : src;

      let tree: MdNode;
      try {
        tree = fromMarkdown(body, { extensions: options.extensions, mdastExtensions: options.mdastExtensions });
      } catch {
        return identityFlat(src); // 解析失败 → 恒等映射，宁可召回差也不崩
      }

      const text: string[] = [];
      const map: number[] = [];
      const mapEnd: number[] = [];
      const inl: number[] = [];
      const isSep: boolean[] = [];
      const constructs: InlineConstruct[] = [];
      const blocks: FlatBlock[] = [];
      let cursor = 0;
      let cur = -1; // 当前最内层行内构造

      const emit = (ch: string, s: number, e: number, sep = false): void => {
        text.push(ch);
        map.push(skip + s);
        mapEnd.push(skip + Math.max(s, e));
        inl.push(cur);
        isSep.push(sep);
        cursor += 1;
      };

      /**
       * 逐字符发射一段可见文本，并在源码中精确定位。
       *
       * @remarks
       * `map` 必须与 `text` **同长同序**（按 code unit），否则下游拿 code unit
       * 下标去查 `map` 会整体错位 —— 代理对字符最容易踩到：
       * 按码点写一条、按 code unit 存两个，长度就差了。
       *
       * 所以代理对拆成两条：两条都指向同一个源码区间，`mapEnd` 覆盖整对。
       */
      const emitText = (value: string, from: number, to: number): void => {
        let p = from;
        let k = 0;
        while (k < value.length) {
          const cp = value.codePointAt(k) as number;
          const ch = String.fromCodePoint(cp);
          const width = cp > 0xffff ? 2 : 1;
          p = alignTo(body, p, to, ch);
          if (p >= to) {
            for (let j = 0; j < width; j++) emit(value[k + j] as string, to, to);
            k += width;
            continue;
          }
          const e = charEnd(body, p, to);
          for (let j = 0; j < width; j++) emit(value[k + j] as string, p, e);
          p = e;
          k += width;
        }
      };

      const bounds = (n: MdNode): [number, number] => {
        let s = nodeStart(n);
        let e = nodeEnd(n);
        for (const c of n.children ?? []) {
          s = Math.min(s, nodeStart(c));
          e = Math.max(e, nodeEnd(c));
        }
        return [s, e];
      };

      const collect = (node: MdNode): boolean => {
        const t = node.type;
        if (SKIP_TYPES.has(t)) return false;

        if (t === 'text') {
          if (!node.value) return false;
          emitText(node.value, nodeStart(node), nodeEnd(node));
          return true;
        }
        if (t === 'inlineCode') {
          if (!node.value) return false;
          const start = nodeStart(node);
          const end = nodeEnd(node);
          let cs = start;
          while (cs < end && body[cs] === '`') cs += 1;
          if (cs < end && body[cs] === ' ' && !node.value.startsWith(' ')) cs += 1;
          let ce = end;
          while (ce > cs && body[ce - 1] === '`') ce -= 1;
          /**
           * 反引号也是行内标记 —— 必须登记进 `constructs`。
           *
           * 这里早先直接 `return`，绕过了下面的 `INLINE_TYPES` 分支：
           * 于是行内代码既不在 `constructs` 里，`inl` 也全是 -1，
           * `expandToInlineMarkers` 无从补齐，引用会切出半截反引号
           * （`React 18\` 通过在…`）。`INLINE_TYPES` 里的 `inlineCode` 是死配置。
           */
          constructs.push({
            start: start + skip,
            end: end + skip,
            contentStart: cs + skip,
            contentEnd: ce + skip,
            parent: cur,
          });
          const saved = cur;
          cur = constructs.length - 1;
          emitText(node.value, cs, end);
          cur = saved;
          return true;
        }
        if (t === 'code') {
          if (!node.value) return false;
          // 内容从围栏后的第一个换行开始
          const nl = body.indexOf('\n', nodeStart(node));
          const from = nl < 0 || nl >= nodeEnd(node) ? nodeStart(node) : nl + 1;
          emitText(node.value, from, nodeEnd(node));
          return true;
        }
        if (t === 'break') {
          emit('\n', nodeStart(node), nodeEnd(node));
          return true;
        }

        let pushed = -1;
        if (INLINE_TYPES.has(t)) {
          const [s, e] = bounds(node);
          // 内容区间 = 子节点的包围盒。注意不能取节点自身区间：
          // `**被告**` 的内容是「被告」，取自身会把 `**` 算进内容，
          // span 扩展的判定条件（是否被切进内容）就永远不成立。
          let cs = s;
          let ce = e;
          const kids = (node.children ?? []).filter((c) => nodeStart(c) < nodeEnd(c));
          if (kids.length > 0) {
            cs = Math.min(...kids.map(nodeStart));
            ce = Math.max(...kids.map(nodeEnd));
          } else if (t === 'inlineCode') {
            let a = s;
            while (a < e && body[a] === '`') a += 1;
            if (a < e && body[a] === ' ') a += 1;
            let b = e;
            while (b > a && body[b - 1] === '`') b -= 1;
            cs = a;
            ce = b;
          }
          // 坐标统一换算到「最原始源码」（含被跳过的 front matter）
          constructs.push({
            start: s + skip,
            end: e + skip,
            contentStart: cs + skip,
            contentEnd: ce + skip,
            parent: cur,
          });
          pushed = constructs.length - 1;
          cur = pushed;
        }

        let any = false;
        for (const c of node.children ?? []) if (collect(c)) any = true;

        if (pushed >= 0) cur = constructs[pushed].parent;
        return any;
      };

      const walkBlocks = (node: MdNode): boolean => {
        if (SKIP_TYPES.has(node.type)) return false;
        const before = cursor;
        const isBlock = BLOCK_TYPES.has(node.type);
        let any = false;
        if (isBlock) {
          any = collect(node);
        } else {
          for (const c of node.children ?? []) if (walkBlocks(c)) any = true;
        }
        if (!any) return false;
        if (isBlock) {
          blocks.push({
            start: before,
            end: cursor,
            srcStart: skip + nodeStart(node),
            srcEnd: skip + nodeEnd(node),
          });
          for (const ch of sep) emit(ch, nodeEnd(node), nodeEnd(node) + 1, true);
        }
        return true;
      };

      for (const top of tree.children ?? []) walkBlocks(top);

      const total = body.length;
      map.push(skip + total);
      mapEnd.push(skip + total);
      inl.push(-1);
      isSep.push(false);
      // back：摊平文本 → 自身，恒等（供坐标换算统一处理）
      const back: number[] = [];
      for (let i = 0; i <= text.length; i++) back.push(i);

      return { text: text.join(''), map, mapEnd, back, blocks, inl, constructs, isSep };
    },
  };
}

function nodeStart(n: MdNode): number {
  return n.position?.start.offset ?? 0;
}
function nodeEnd(n: MdNode): number {
  return n.position?.end.offset ?? 0;
}

function identityFlat(src: string): FlatResult {
  const map: number[] = [];
  const mapEnd: number[] = [];
  const back: number[] = [];
  for (let i = 0; i <= src.length; i++) {
    map.push(i);
    mapEnd.push(i);
    back.push(i);
  }
  return {
    text: src,
    map,
    mapEnd,
    back,
    blocks: [{ start: 0, end: src.length, srcStart: 0, srcEnd: src.length }],
    inl: [],
    constructs: [],
    isSep: [],
  };
}

/**
 * 零依赖降级版摊平器：用正则剥离常见标记。
 *
 * **只在无法引入 mdast 时使用**。表格、嵌套列表、转义都处理不干净，
 * 坐标是近似值。推荐路径是 {@link createMdastFlattener}。
 *
 * @remarks
 * 保留它只是为了让「没有 mdast 也能跑」，不是推荐方案。
 */
export const regexFlattener: MarkdownFlattener = {
  flatten(src: string): FlatResult {
    const text: string[] = [];
    const map: number[] = [];
    const mapEnd: number[] = [];
    let i = 0;

    const push = (ch: string, s: number, e: number): void => {
      text.push(ch);
      map.push(s);
      mapEnd.push(Math.max(s, e));
    };

    /** 一段可见文本与源码逐字符对应 */
    const keep = (s: string, at: number): void => {
      for (let k = 0; k < s.length; k++) push(s[k], at + k, at + k + 1);
    };

    /** 一段源码解码出的可见字符：每个字符横跨整个源码片段 */
    const keepFrom = (value: string, srcFrom: number, srcTo: number): void => {
      for (let k = 0; k < value.length; k++) push(value[k], Math.min(srcFrom + k, srcTo), srcTo);
    };

    while (i < src.length) {
      if (src[i] === '!' && src[i + 1] === '[') {
        const m = /^!\[[^\]]*\]\([^)]*\)/.exec(src.slice(i));
        if (m) {
          i += m[0].length;
          continue;
        }
      }
      if (src[i] === '[') {
        const m = /^\[([^\]]*)\]\([^)]*\)/.exec(src.slice(i));
        if (m) {
          keep(m[1], i + 1);
          i += m[0].length;
          continue;
        }
      }
      if (src.startsWith('```', i)) {
        const end = src.indexOf('```', i + 3);
        const stop = end < 0 ? src.length : end;
        keep(src.slice(i, stop).replace(/^```[^\n]*\n?/, ''), i);
        i = end < 0 ? src.length : end + 3;
        continue;
      }
      const m = /^(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+|\|\s*)/.exec(src.slice(i));
      if (m && (i === 0 || src[i - 1] === '\n')) {
        i += m[0].length;
        continue;
      }
      const line = src.slice(i).split('\n')[0] ?? '';
      if (src[i] === '|' && /^\|?[\s:|-]+\|\s*$/.test(line)) {
        i += line.length + 1;
        continue;
      }
      if (src[i] !== '\n' && /^[*_~`]/.test(src[i])) {
        const m2 = /^[*_~`]{1,3}/.exec(src.slice(i)) as RegExpExecArray;
        i += m2[0].length;
        continue;
      }
      if (src[i] === '&') {
        // 和 mdast 路径保持一致：实体要解码，且一个可见字符横跨整个引用
        const ent = readEntity(src, i, src.length);
        if (ent && ent.value.length > 0) {
          keepFrom(ent.value, i, ent.endPos);
          i = ent.endPos;
          continue;
        }
      }
      if (src[i] === '\\' && i + 1 < src.length) {
        // 转义占两个源码字符 —— 只算 `\` 的话回切会丢掉被转义的字符
        push(src[i + 1], i, Math.min(src.length, i + 2));
        i += 2;
        continue;
      }
      keep(src[i], i);
      i += 1;
    }
    const back: number[] = [];
    for (let k = 0; k <= text.length; k++) back.push(k);
    map.push(src.length);
    mapEnd.push(src.length);
    return {
      text: text.join(''),
      map,
      mapEnd,
      back,
      blocks: [{ start: 0, end: text.length, srcStart: 0, srcEnd: src.length }],
      inl: [],
      constructs: [],
      isSep: [],
    };
  },
};

const MD_EDGE_CHARS = new Set(['*', '_', '`', '~', '#', '>', '|', '-', '\\']);

/**
 * 修剪粘在 span 首尾的纯语法标记（`*`、`_`、`` ` ``、`~`、`#`、`>`、`|`、`-`、`\`）。
 *
 * @remarks
 * 默认不启用（{@link MatchOptions.trimMarkdownEdges} 为 `false`）：
 * 它会把刚由 {@link expandToInlineMarkers} 补齐的 `**` 又剪掉，与「精确」冲突。
 * 仅在需要让高亮区间更干净时按需开启。
 */
export function trimMarkdownEdges(src: string, index: number, length: number): { index: number; length: number } {
  let s = index;
  let e = index + length;
  while (e > s && MD_EDGE_CHARS.has(src[e - 1])) e -= 1;
  while (s < e && MD_EDGE_CHARS.has(src[s])) s += 1;
  return { index: s, length: e - s };
}

/**
 * 把 span 向外扩展到完整的行内标记。
 *
 * **原因**：摘录「被告的行为…」在源码中起点是 `**` 之后的「被」，
 * 直接回切会得到 `被告**的行为` —— 少了开头的 `**`，渲染后强调丢失，且不是合法片段。
 *
 * **规则**（只补标记，不吞兄弟内容）：
 * - 起点：若被切进某个构造的内容起点，补上它**最内层**的开始标记
 * - 终点：若已覆盖到某个构造的内容终点，补上它**最内层**的结束标记
 *
 * 所以 `**a _b_ c**` 中摘录 `"b"` → span 是 `_b_`，而不是整段 `**a _b_ c**`；
 * 摘录「被告」→ span 是 `**被告**`。
 *
 * @param flat 摊平结果（提供 `constructs` 与 `inl`）
 * @param fromFlat span 起点在摊平文本中的下标
 * @param toFlat span 终点在摊平文本中的下标
 * @param srcStart 当前 span 的源码起点
 * @param srcEnd 当前 span 的源码终点
 * @returns 扩展后的源码区间 `{ start, end }`
 */
export function expandToInlineMarkers(
  flat: FlatResult,
  fromFlat: number,
  toFlat: number,
  srcStart: number,
  srcEnd: number
): { start: number; end: number } {
  const list = flat.constructs;
  const inl = flat.inl;
  if (!list || !inl || list.length === 0) return { start: srcStart, end: srcEnd };

  let s = srcStart;
  let e = srcEnd;

  const fi = Math.max(0, Math.min(fromFlat, inl.length - 1));
  for (let ci = inl[fi]; ci >= 0; ci = list[ci].parent) {
    const c = list[ci];
    if (c.start < s && c.contentStart >= s) {
      s = c.start;
      break;
    }
  }
  const ti = Math.max(0, Math.min(toFlat, inl.length - 1));
  for (let ci = inl[ti]; ci >= 0; ci = list[ci].parent) {
    const c = list[ci];
    if (c.end > e && c.contentEnd <= e) {
      e = c.end;
      break;
    }
  }
  return { start: s, end: e };
}

/**
 * 派生「无分隔符」视图：删掉所有块间分隔符，让块首尾直接相邻。
 *
 * **为什么需要**：用户复制跨段摘录时经常不带换行 ——
 * 「上一段末尾。下一段开头」，而源码里两段之间有我们插入的分隔符，严格比对必然失败。
 *
 * 这不是放宽匹配，而是承认「块边界是排版产物，不是内容」：
 * 段落之间的换行渲染后确实是空白，用户复制时丢失它是常态而非异常。
 *
 * **派生而非重新解析**：过滤数组即可，不必再跑一遍 mdast。
 *
 * @param flat 摊平结果
 * @returns 无分隔符视图；`null` 表示没有分隔符（单块或纯文本）
 *
 * @remarks
 * 调用方应拿它**参与「取最早」的比较**，不要单独用它决定结果 ——
 * 否则会丢掉严格视图里更靠前的命中。
 *
 * 返回值自带三样派生数据，坐标系如各字段所述：
 * - `back`：joined 下标 → **摊平文本**下标（keep 数组 + 末尾哨兵，升序）
 * - `blocks`：块切片，已换算到 **joined raw** 坐标
 * - `map` / `mapEnd` / `inl`：同链换算，仍指向 **md 源码**
 *
 * **坐标复合陷阱**：把 joined 结果再喂给 `normalizeWithMap` 时，返回的
 * `norm.back` 指向的是**摊平文本**而不是 joined raw —— 因为 `j.back`
 * （joined → 摊平）已被复合进去。需要「归一化下标 → joined raw」时，
 * 必须拿 `j.back` 再补一跳（升序数组二分：`raw 下标 = 严格小于 q 的元素个数`）；
 * 直接拿归一化的 `back` 去切 joined 的 `text` 会整体错位，
 * 偏移量正是已剥掉的分隔符数。
 */
export function deriveJoined(flat: FlatResult): FlatResult | null {
  const isSep = flat.isSep;
  if (!isSep || isSep.length === 0) return null;

  const keep: number[] = [];
  for (let i = 0; i < flat.text.length; i++) if (!isSep[i]) keep.push(i);
  if (keep.length === flat.text.length) return null; // 没有分隔符

  const toJoined = (pos: number): number => {
    let lo = 0;
    let hi = keep.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (keep[mid] < pos) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };

  const text: string[] = [];
  const map: number[] = [];
  const mapEnd: number[] = [];
  const back: number[] = []; // joined 下标 → flat 下标
  const inl: number[] = [];
  for (const i of keep) {
    text.push(flat.text[i]);
    map.push(flat.map[i]);
    mapEnd.push(flat.mapEnd?.[i] ?? flat.map[i]);
    back.push(i);
    inl.push(flat.inl?.[i] ?? -1);
  }
  const last = flat.map.length - 1;
  map.push(flat.map[last]);
  mapEnd.push(flat.mapEnd?.[last] ?? flat.map[last]);
  back.push(flat.text.length);

  return {
    text: text.join(''),
    map,
    mapEnd,
    back,
    blocks: flat.blocks.map((b) => ({ ...b, start: toJoined(b.start), end: toJoined(b.end) })),
    inl,
    constructs: flat.constructs,
  };
}
