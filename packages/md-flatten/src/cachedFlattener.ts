import { Cache } from 'secondary-cache';
import type { FlatResult, MarkdownFlattener } from './markdown';

/**
 * 摊平结果的缓存包装。
 *
 * @remarks
 * ## 为什么需要它
 *
 * 实测 800 段（约 6 万字符）的 md：
 *
 * ```
 * mdast 摊平  298.6ms   ← 88%
 * 归一化       41.7ms
 * ```
 *
 **瓶颈是 mdast 解析，不是归一化。** 而 `TextIndex` 的缓存是**实例级**的 ——
 * 同一份文档被两个 index 持有，就要解析两遍：
 *
 * ```ts
 * createTextIndex(doc, { markdown: md });  // 298ms
 * createTextIndex(doc, { markdown: md });  // 又 298ms，同一份文档
 * ```
 *
 * 摊平只依赖 flattener，**不依赖 MatchOptions** —— 换选项时重建是纯浪费。
 * 本包装把缓存提升到 flattener 层，跨 index、跨 options 共享。
 *
 * 复用收益（800 段）：
 *
 * | 用法 | 单次耗时 |
 * |---|---|
 * | 复用索引 | 1.96ms |
 * | 每次重建 | 165.5ms |
 *
 * ## key 策略：**优先 docId，没有才回退全文**
 *
 * 全文当 key 有两个问题：
 *
 * 1. **内存**：文档越大，key 本身越占空间（缓存里等于存了两份）
 * 2. **相等性**：只能靠字符串比较，无法表达"同一个文档的两个版本"
 *
 * 所以优先用 `docId`（如数据库主键、文件路径、内容 hash）。调用方可通过
 * {@link CachedFlattenerOptions.docIdOf} 从文档里提取（如 front matter 的
 * `id:` 字段），或直接 {@link CachedFlattener.flattenById} 传入。
 *
 * 注意：**docId 相同就意味着内容相同**。若同一 id 下内容会变（如编辑器里的
 * 实时草稿），请不要用 id 作 key，或让 `docIdOf` 返回 `undefined` 走全文。
 *
 * @packageDocumentation
 */

/** 缓存配置 */
export interface CachedFlattenerOptions {
  /**
   * LRU 容量上限。
   *
   * @remarks
   * 按**文档数**计，不是字节数。默认 32 —— 对大多数"同时处理若干文档"的
   * 服务够用；批处理大语料时请调小，避免结果常驻。
   *
   * @defaultValue 32
   */
  max?: number;
  /**
   * 从文档源码里提取稳定 id。
   *
   * @remarks
   * 返回 `undefined` 则回退用**全文**作 key。
   *
   * 典型实现：解析 front matter 的 `id:` 字段。注意它会在**每次未命中时**
   * 调用，所以应当廉价（不要在里面做 md 解析）。
   *
   * @example
   * ```ts
   * docIdOf: (src) => /^---\r?\nid:\s*(\S+)/m.exec(src)?.[1]
   * ```
   */
  docIdOf?: (src: string) => string | undefined;
}

/** 带缓存的摊平器，接口与 {@link MarkdownFlattener} 一致 */
export interface CachedFlattener extends MarkdownFlattener {
  /**
   * 显式指定 id 后摊平 —— 绕过 {@link CachedFlattenerOptions.docIdOf}，
   * 也避免把全文当 key。
   *
   * @remarks
   * 这是**推荐用法**：调用方通常早就知道文档 id（数据库主键、文件路径），
   * 没必要让库去猜。
   */
  flattenById(src: string, docId: string): FlatResult;
  /** 当前缓存条目数，供测试与运维观察是否稳定 */
  readonly size: number;
  /** 清空缓存 */
  clear(): void;
}

/**
 * 给摊平器套一层缓存。
 *
 * @param base 底层摊平器（如 {@link createMdastFlattener} 的产物）
 * @param options 见 {@link CachedFlattenerOptions}
 *
 * @example
 * ```ts
 * const md = createCachedFlattener(createMdastFlattener(fromMarkdown), {
 *   max: 64,
 *   docIdOf: (src) => /^id:\s*(\S+)/m.exec(src)?.[1],
 * });
 *
 * md.flattenById(doc, 'doc-42');  // 推荐：显式 id
 * md.flatten(doc);                // 回退：docIdOf 或全文
 * ```
 */
export function createCachedFlattener(
  base: MarkdownFlattener,
  options: CachedFlattenerOptions = {}
): CachedFlattener {
  const cache = new Cache({ capacity: options.max ?? DEFAULT_MAX });
  const docIdOf = options.docIdOf;

  /** id 键加前缀，避免与全文键碰撞（理论上可能：某文档内容恰好等于另一个的 id） */
  const idKey = (id: string) => `\u0000id:${id}`;

  function flattenById(src: string, docId: string): FlatResult {
    const key = idKey(docId);
    const hit = cache.get(key) as FlatResult | undefined;
    if (hit) return hit;
    const r = base.flatten(src);
    cache.set(key, r);
    return r;
  }

  function flatten(src: string): FlatResult {
    const id = docIdOf?.(src);
    if (id !== undefined) return flattenById(src, id);
    // 回退：全文作 key
    const hit = cache.get(src) as FlatResult | undefined;
    if (hit) return hit;
    const r = base.flatten(src);
    cache.set(src, r);
    return r;
  }

  return {
    flatten,
    flattenById,
    get size() {
      return cache.length();
    },
    clear() {
      cache.clear();
    },
  };
}

/** 默认容量：按文档数计 */
const DEFAULT_MAX = 32;
