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
 * ## 为什么是惰性 require 而不是静态 import
 *
 * - `cjk-number` 与 `diff-match-patch-es` 是**纯 ESM** 包：CJS 产物在旧 Node
 *   （< 20.19 / < 22.12，无 require(esm)）上根本加载不到它们；
 * - `@isdk/nlp-jieba` 在模块加载时就要 `fs.readFileSync` 读 wasm；
 * - mdast 解析器只该在真的要摊平时才初始化。
 *
 * 惰性 + 记忆化让「用不到就不付成本」；某个默认加载失败时按「无此默认」
 * 降级（对应能力关闭，返回 `undefined`），而不是让整个包在加载期崩溃 ——
 * 调用方仍然可以显式注入自己的实现。
 *
 * ## 边界
 *
 * 默认装配面向 **Node**。浏览器等无 Node 模块系统的环境拿不到这些默认，
 * 请显式传入 `markdown` / `fallbacks` 等选项（与旧版用法一致）。
 *
 * @packageDocumentation
 */

import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMdastFlattener } from '@isdk/md-flatten';
import { createCjkNumberParser } from '@isdk/normalize-text';
import type { CjkNumberLike, ChineseNumeralParser } from '@isdk/normalize-text';
import { createJiebaParticleTagger } from '@isdk/zh-particles';
import type { JiebaLike, ParticleTagger } from '@isdk/zh-particles';
import type { DmpEsLike } from '@isdk/approx-text-match';

import { createDmpEsFallback } from './fuzzyMatch';
import type { FallbackMatcher, MarkdownFlattener } from './types';

/**
 * 基于本包安装位置的 require。
 *
 * @remarks
 * `import.meta.url` 在两种产物里都指向自身文件（esbuild 会把 CJS 里的
 * `import.meta.url` 换成本文件路径），Node 解析从包的 node_modules 开始，
 * 与包管理器的依赖可见性一致。
 */
const nodeRequire = createRequire(import.meta.url);

/**
 * 加载一个默认依赖模块。
 *
 * @remarks
 * 两段式，覆盖两种 exports 形态：
 *
 * 1. **普通 require** —— 双格式包（mdast 三件套、jieba）与字符串型 exports 的
 *    纯 ESM 包（`diff-match-patch-es`，Node ≥ 20.19 的 require(esm) 可加载）一次成功；
 * 2. **手动解析回退** —— `cjk-number` 这类 exports 映射里**只有 `import` 条件**的包，
 *    `require()` 必报 `ERR_PACKAGE_PATH_NOT_EXPORTED`。从本文件位置向上找到
 *    `node_modules/<id>/package.json`，取其 `import` 条件的入口文件，
 *    按**绝对路径** require —— 绕过 exports 映射，Node ≥ 20.19 照样能把 ESM
 *    文件 require 进来。
 *
 * 失败一律返回 `undefined` 并记住（见 {@link requireOptional}），按「无此默认」降级。
 */
function requireDefault(id: string): unknown | undefined {
  try {
    return nodeRequire(id);
  } catch {
    // fall through：exports 映射没有 require 条件的纯 ESM 包
  }
  try {
    return nodeRequire(entryOf(id));
  } catch {
    return undefined; // 旧 Node 的 CJS 产物 / 无 Node 模块系统的环境
  }
}

interface PkgJson {
  exports?: Record<string, unknown>;
  main?: string;
}

/** 从 exports 的「.」映射里挑一个可 require 的入口：node → require → import → default */
function entryFromExports(exp: unknown): string | undefined {
  if (typeof exp === 'string') return exp;
  if (!exp || typeof exp !== 'object') return undefined;
  const o = exp as Record<string, unknown>;
  for (const key of ['node', 'require', 'import', 'default']) {
    const cond = o[key] as { default?: string } | string | undefined;
    const target = typeof cond === 'string' ? cond : cond?.default;
    if (target) return target;
  }
  return undefined;
}

/**
 * 手动解析包的真实入口文件。
 *
 * @remarks
 * 不能用 `import.meta.resolve`：vite-node（vitest）不提供它，CJS 产物里也被
 * esbuild 换成了没有 `resolve` 的垫片。node_modules 上溯 + 读 package.json
 * 在三种环境（vitest 源码、ESM 产物、CJS 产物）下行为一致。
 */
function entryOf(id: string): string {
  const segs = id.split('/');
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const pkgDir = path.join(dir, 'node_modules', ...segs);
    const pkgJson = path.join(pkgDir, 'package.json');
    if (existsSync(pkgJson)) {
      const pkg = JSON.parse(readFileSync(pkgJson, 'utf8')) as PkgJson;
      const entry = entryFromExports(pkg.exports?.['.']) ?? pkg.main;
      if (!entry) throw new Error(`no entry for ${id}`);
      return path.join(pkgDir, entry);
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`module not found: ${id}`);
    dir = parent;
  }
}

/** 惰性 + 记忆化的模块加载；失败记住 `undefined`，不反复重试 */
const cache = new Map<string, unknown>();
function requireOptional<T>(id: string): T | undefined {
  if (!cache.has(id)) cache.set(id, requireDefault(id));
  return cache.get(id) as T | undefined;
}

let flattener: MarkdownFlattener | null | undefined;

/**
 * 内置默认 md 摊平器（mdast + GFM），进程内只装配一次。
 *
 * @returns 摊平器；GFM 三件套加载失败时为 `undefined`（调用方按纯文本处理）
 *
 * @remarks
 * GFM（表格 / 删除线 / 任务列表 / 自动链接）与 CommonMark 一并支持 ——
 * 摘录最常见的出处就是这两种语法写成的文档。
 */
export function defaultMarkdownFlattener(): MarkdownFlattener | undefined {
  flattener ??= buildMarkdownFlattener();
  return flattener ?? undefined;
}

function buildMarkdownFlattener(): MarkdownFlattener | null {
  const fromMarkdownMod =
    requireOptional<typeof import('mdast-util-from-markdown')>('mdast-util-from-markdown');
  const gfmMod = requireOptional<typeof import('micromark-extension-gfm')>('micromark-extension-gfm');
  const gfmFromMarkdownMod = requireOptional<typeof import('mdast-util-gfm')>('mdast-util-gfm');
  if (!fromMarkdownMod || !gfmMod || !gfmFromMarkdownMod) return null;
  try {
    return createMdastFlattener(
      // 适配签名：mdast 的 options 类型与本包的 `FromMarkdown` 结构别名不完全一致
      (src, options) => fromMarkdownMod.fromMarkdown(src, options as Parameters<typeof fromMarkdownMod.fromMarkdown>[1]),
      {
        extensions: [gfmMod.gfm()],
        mdastExtensions: [gfmFromMarkdownMod.gfmFromMarkdown()],
      }
    );
  } catch {
    return null;
  }
}

let fuzzy: FallbackMatcher | null | undefined;

/**
 * 内置默认 T3 模糊匹配器（`diff-match-patch-es`：Bitap 定位 + diff 精修）。
 * 同时用作 T4 语义命中的段内对齐器（{@link defaultMarkdownFlattener} 同款记忆化）。
 *
 * @returns 匹配器；`diff-match-patch-es` 加载失败时为 `undefined`
 */
export function defaultFuzzyFallback(): FallbackMatcher | undefined {
  fuzzy ??= buildFuzzyFallback();
  return fuzzy ?? undefined;
}

function buildFuzzyFallback(): FallbackMatcher | null {
  const dmpEs = requireOptional<DmpEsLike>('diff-match-patch-es');
  if (!dmpEs || typeof dmpEs.match !== 'function' || typeof dmpEs.diff !== 'function') return null;
  return createDmpEsFallback(dmpEs);
}

let cjkParser: ChineseNumeralParser | null | undefined;

/**
 * 内置默认中文数词解析器（`cjk-number`：一千 ≡ 1000，含大写 / 口语 / 年份）。
 *
 * @returns 解析器；`cjk-number` 加载失败时为 `undefined`
 */
export function defaultCjkNumberParser(): ChineseNumeralParser | undefined {
  cjkParser ??= buildCjkNumberParser();
  return cjkParser ?? undefined;
}

function buildCjkNumberParser(): ChineseNumeralParser | null {
  const cjk = requireOptional<CjkNumberLike>('cjk-number');
  if (!cjk || typeof cjk.number?.parse !== 'function') return null;
  return createCjkNumberParser(cjk);
}

let tagger: ParticleTagger | null | undefined;

/**
 * 内置默认「的 / 地 / 得」判定器（`@isdk/nlp-jieba`，词典驱动，词性感知）。
 *
 * @returns 判定器；jieba 加载失败时为 `undefined`
 *
 * @remarks
 * jieba 的 WASM 与词典只在首次真正折叠时才加载（见
 * `createJiebaParticleTagger` 的惰性 `addDefaultDict`）。
 */
export function defaultParticleTagger(): ParticleTagger | undefined {
  tagger ??= buildParticleTagger();
  return tagger ?? undefined;
}

function buildParticleTagger(): ParticleTagger | null {
  const jieba = requireOptional<JiebaLike>('@isdk/nlp-jieba');
  if (!jieba || typeof jieba.addDefaultDict !== 'function' || typeof jieba.tag !== 'function') return null;
  return createJiebaParticleTagger(jieba);
}
