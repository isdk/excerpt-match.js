/**
 * 内置默认依赖装配 —— 高层入口「零配置可用」的关键。
 *
 * 原本需要调用方注入的能力，现在全部有默认实现；这些第三方库已在**本包必装**
 * （由 `dependencies` 声明，同时满足各子包的可选 peer），按各子包推荐的使用链装配：
 *
 * | 能力 | 子包工厂 | 推荐使用链 |
 * |---|---|---|
 * | md 摊平 | `createMdastFlattener`（@isdk/md-flatten） | `mdast-util-from-markdown` + GFM |
 * | T3 模糊 / T4 对齐 | `createDmpEsFallback` | `diff-match-patch-es` |
 * | 中文数词 | `createCjkNumberParser`（@isdk/normalize-text） | `cjk-number` |
 * | 的/地/得 | `createJiebaParticleTagger`（@isdk/zh-particles） | `@isdk/nlp-jieba` |
 *
 * ## 为什么是惰性动态 import 而不是静态 import
 *
 * - **运行时无关**：本文件不 `import` 任何 `node:*` 模块，浏览器 / Deno / edge
 *   走同一条代码路径；某个默认加载失败时按「无此默认」降级（对应能力关闭，
 *   返回 `undefined`），而不是让整个包在加载期崩溃；
 * - `cjk-number` 与 `diff-match-patch-es` 是**纯 ESM** 包：若被静态 import，
 *   CJS 产物会把它们编成顶层 `require` —— 前者 exports 映射只有 `import` 条件，
 *   任何 Node 版本都报 `ERR_PACKAGE_PATH_NOT_EXPORTED`；
 * - 惰性 + 记忆化让「用不到就不付成本」：jieba 的 wasm + 词典、mdast 初始化
 *   只由真正用到高层入口相应能力的调用方支付；
 * - **打包友好**：动态 `import()` 让 vite/webpack 等把重依赖拆成按需 chunk，
 *   未走到的默认不产生加载成本。
 *
 * ## 边界
 *
 * 默认装配**运行时无关**：只依赖 ECMAScript 动态 `import()` 与字面量模块名，
 * 不 `import` 任何 `node:*` 模块 —— 浏览器 / Deno / edge 走同一条代码路径。
 * 依赖由打包器按字面量静态拆块，环境里解析不到时（无 node_modules 或
 * 未配置别名）自然降级为「无此默认」—— 调用方仍可显式传入
 * `markdown` / `fallbacks` 等选项（与旧版用法一致）。
 *
 * @packageDocumentation
 */

import { createMdastFlattener } from '@isdk/md-flatten';
import { createCjkNumberParser } from '@isdk/normalize-text';
import type { CjkNumberLike, ChineseNumeralParser } from '@isdk/normalize-text';
import { createJiebaParticleTagger } from '@isdk/zh-particles';
import type { JiebaLike, ParticleTagger } from '@isdk/zh-particles';
import type { DmpEsLike } from '@isdk/approx-text-match';

import { createDmpEsFallback } from './fuzzyMatch';
import type { FallbackMatcher, MarkdownFlattener } from './types';

/**
 * 惰性 + 记忆化的动态 import；失败记住 `undefined`，不反复重试。
 *
 * @remarks
 * 并发安全：缓存的是 Promise 本身，同 id 的并发调用共享同一次加载。
 *
 * **每个依赖必须是字面量说明符**（`import('cjk-number')`，且不能经由参数
 * 间接传入）：打包器（vite / webpack / rolldown）只能静态分析字面量，
 * 才能把纯 ESM 依赖拆成按需 chunk —— 浏览器里动态 import 才真正可用，
 * 未走到的默认不产生加载成本。变量形态的 `import(id)` 在浏览器里是
 * 无法解析的裸说明符（已用打包测试钉住）。Node 侧（CJS 产物）esbuild
 * 对 external 的动态 import 原样保留，同样走标准 ESM 加载。
 *
 * 所有默认依赖都以**命名导出**可用（mdast 三件套、`diff-match-patch-es`、
 * `cjk-number` 本就是 ESM 命名导出；`@isdk/nlp-jieba` 的 nodejs 构建被
 * `import()` 后命名导出与 `default` 并存），因此直接按命名导出使用。
 */
const cache = new Map<string, Promise<unknown>>();
function memo(id: string, load: () => Promise<unknown>): Promise<unknown> {
  let p = cache.get(id);
  if (!p) {
    p = load().catch(() => undefined);
    cache.set(id, p);
  }
  return p;
}

// 每个依赖一个字面量加载点（打包器只认字面量），memo 统一记忆化 + 失败降级
const loadFromMarkdown = () => memo('mdast-util-from-markdown', () => import('mdast-util-from-markdown'));
const loadGfm = () => memo('micromark-extension-gfm', () => import('micromark-extension-gfm'));
const loadGfmFromMarkdown = () => memo('mdast-util-gfm', () => import('mdast-util-gfm'));
const loadDmpEs = () => memo('diff-match-patch-es', () => import('diff-match-patch-es'));
const loadCjkNumber = () => memo('cjk-number', () => import('cjk-number'));
const loadJieba = () => memo('@isdk/nlp-jieba', () => import('@isdk/nlp-jieba'));

let flattener: Promise<MarkdownFlattener | null> | undefined;

/**
 * 内置默认 md 摊平器（mdast + GFM），进程内只装配一次。
 *
 * @returns 摊平器；GFM 三件套加载失败时为 `undefined`（调用方按纯文本处理）
 *
 * @remarks
 * GFM（表格 / 删除线 / 任务列表 / 自动链接）与 CommonMark 一并支持 ——
 * 摘录最常见的出处就是这两种语法写成的文档。
 */
export function defaultMarkdownFlattener(): Promise<MarkdownFlattener | undefined> {
  flattener ??= buildMarkdownFlattener();
  return flattener.then((v) => v ?? undefined);
}

async function buildMarkdownFlattener(): Promise<MarkdownFlattener | null> {
  const [fromMarkdownMod, gfmMod, gfmFromMarkdownMod] = await Promise.all([
    loadFromMarkdown() as Promise<typeof import('mdast-util-from-markdown') | undefined>,
    loadGfm() as Promise<typeof import('micromark-extension-gfm') | undefined>,
    loadGfmFromMarkdown() as Promise<typeof import('mdast-util-gfm') | undefined>,
  ]);
  if (!fromMarkdownMod || !gfmMod || !gfmFromMarkdownMod) return null;
  try {
    return createMdastFlattener(
      // 适配签名：mdast 的 options 类型与本包的 `FromMarkdown` 结构别名不完全一致
      (src, options) =>
        fromMarkdownMod.fromMarkdown(src, options as Parameters<typeof fromMarkdownMod.fromMarkdown>[1]),
      {
        extensions: [gfmMod.gfm()],
        mdastExtensions: [gfmFromMarkdownMod.gfmFromMarkdown()],
      }
    );
  } catch {
    return null;
  }
}

let fuzzy: Promise<FallbackMatcher | null> | undefined;

/**
 * 内置默认 T3 模糊匹配器（`diff-match-patch-es`：Bitap 定位 + diff 精修）。
 * 同时用作 T4 语义命中的段内对齐器（{@link defaultMarkdownFlattener} 同款记忆化）。
 *
 * @returns 匹配器；`diff-match-patch-es` 加载失败时为 `undefined`
 */
export function defaultFuzzyFallback(): Promise<FallbackMatcher | undefined> {
  fuzzy ??= buildFuzzyFallback();
  return fuzzy.then((v) => v ?? undefined);
}

async function buildFuzzyFallback(): Promise<FallbackMatcher | null> {
  const dmpEs = await loadDmpEs() as DmpEsLike | undefined;
  if (!dmpEs || typeof dmpEs.match !== 'function' || typeof dmpEs.diff !== 'function') return null;
  return createDmpEsFallback(dmpEs);
}

let cjkParser: Promise<ChineseNumeralParser | null> | undefined;

/**
 * 内置默认中文数词解析器（`cjk-number`：一千 ≡ 1000，含大写 / 口语 / 年份）。
 *
 * @returns 解析器；`cjk-number` 加载失败时为 `undefined`
 */
export function defaultCjkNumberParser(): Promise<ChineseNumeralParser | undefined> {
  cjkParser ??= buildCjkNumberParser();
  return cjkParser.then((v) => v ?? undefined);
}

async function buildCjkNumberParser(): Promise<ChineseNumeralParser | null> {
  const cjk = await loadCjkNumber() as CjkNumberLike | undefined;
  if (!cjk || typeof cjk.number?.parse !== 'function') return null;
  return createCjkNumberParser(cjk);
}

let tagger: Promise<ParticleTagger | null> | undefined;

/**
 * 内置默认「的 / 地 / 得」判定器（`@isdk/nlp-jieba`，词典驱动，词性感知）。
 *
 * @returns 判定器；jieba 加载失败时为 `undefined`
 *
 * @remarks
 * jieba 的词典只在首次真正折叠时才加载（见
 * `createJiebaParticleTagger` 的惰性 `addDefaultDict`）；浏览器侧 web 构建
 * 的 wasm 初始化在装配时完成（见 {@link buildParticleTagger}）。
 */
export function defaultParticleTagger(): Promise<ParticleTagger | undefined> {
  tagger ??= buildParticleTagger();
  return tagger.then((v) => v ?? undefined);
}

/**
 * web 构建（浏览器）的 `default` 是 wasm 初始化函数：必须先 await 它才有
 * `wasm` 实例（词典直接编译在 wasm 内，无需 fs）；nodejs 构建在模块加载时
 * 已同步初始化，`default` 是模块对象本身而非函数。返回 undefined = 无需初始化。
 */
function wasmInitOf(mod: object): (() => Promise<unknown>) | undefined {
  const d = (mod as { default?: unknown }).default;
  return typeof d === 'function' ? (d as () => Promise<unknown>) : undefined;
}

async function buildParticleTagger(): Promise<ParticleTagger | null> {
  const jieba = await loadJieba() as JiebaLike | undefined;
  if (!jieba || typeof jieba.addDefaultDict !== 'function' || typeof jieba.tag !== 'function') return null;
  // 浏览器侧先完成 wasm 初始化（幂等，nodejs 构建此处为 undefined）。
  // 初始化失败 = wasm 拿不到，按「无此默认」降级而不是让首次折叠崩溃。
  try {
    await wasmInitOf(jieba)?.();
  } catch {
    return null;
  }
  return createJiebaParticleTagger(jieba);
}
