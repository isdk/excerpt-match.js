/**
 * `.text` 契约测试 —— 固化 excerptMatcher.ts 里报告过的那次类型错误：
 *
 * ```
 * excerptMatcher.ts: Property 'text' does not exist on type 'FlatResult'.
 * ```
 *
 * 错误现场（excerptMatcher.ts 的 `toResult`）：
 *
 * ```ts
 * visible = resolved.markdown.flatten(source).text.replace(/\s+$/, '');
 * ```
 *
 * ## 为什么会报错
 *
 * `text` **不是 `FlatResult` 自己声明的字段**，而是继承来的：
 *
 * ```
 * excerptMatcher.ts
 *   └─ MarkdownFlattener.flatten(): FlatResult          ← @isdk/md-flatten（经 ./types re-export）
 *        └─ interface FlatResult extends NormalizedText
 *             └─ interface NormalizedText { text: string; … }   ← @isdk/normalize-text
 * ```
 *
 * TS 必须把这条链上每一环的 **编译产物 d.ts**（两个子包的 `types` 都指向
 * `dist/index.d.ts`）全部解析成功，才看得到 `text`。链上任一环是旧构建
 * （例如 `FlatResult` 尚未 `extends NormalizedText` 时期的 dist）、或依赖
 * 半重装（pnpm 的 `.ignored_*` 残留）时，`text` 就会「凭空消失」——
 * 源码一行没改，编译照报错。所以这类错误属于**类型解析环境**问题：
 * 修复手段是重建子包 / 重装依赖 / 重启 TS server，而不是改本包源码。
 *
 * ## 固化方式
 *
 * - **编译期**：下面的 `expectTypeOf` 断言位于 `src/`，被根 tsconfig 的
 *   `pnpm typecheck`（`tsc --noEmit`）覆盖。它走的是与错误现场**同一条
 *   解析路径**（`./types` → `@isdk/md-flatten` → `@isdk/normalize-text`）——
 *   继承链一断，typecheck 就在断言处报出与用户侧一致的错误，CI 红灯
 *   代替用户侧报障。
 * - **运行期**：钉死行为契约 —— `matchExcerpt(...).text` 永远是
 *   「剥掉 md 语法标记的可见文本」，且单块命中不带块分隔符尾换行。
 */

import { describe, expect, expectTypeOf, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener } from '@isdk/md-flatten';
import { matchExcerpt } from './excerptMatcher';
import type { FlatResult } from './types';

const md = createMdastFlattener(fromMarkdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
}) as never;

describe('FlatResult 的 text 契约（编译期，pnpm typecheck 守护）', () => {
  // 索引访问 `FlatResult['text']` 在编译期展开：`text` 若从继承链上消失，
  // tsc 就在这里报出与 excerptMatcher.ts 一致的
  // 「Property 'text' does not exist on type 'FlatResult'」
  it('★ FlatResult 必须带 text（继承自 NormalizedText）', () => {
    expectTypeOf<FlatResult['text']>().toEqualTypeOf<string>();
    expectTypeOf<FlatResult['map']>().toEqualTypeOf<number[]>();
  });

  it('★ flatten(...) 的返回值可直接取 .text（错误现场同款表达式）', () => {
    const flat = createMdastFlattener(fromMarkdown).flatten('**被告**的行为');
    expectTypeOf(flat.text).toEqualTypeOf<string>();
  });
});

describe('FlatResult 的 text 契约（运行期）', () => {
  it('flatten().text 剥掉 md 标记，但保留末尾块分隔符 —— 修剪是 toResult 的职责', () => {
    const flat = createMdastFlattener(fromMarkdown).flatten('# 标题\n\n**被告**的行为构成根本违约。');
    // 每个块之后都发分隔符（含最后一块），所以原样摊平带尾换行 ——
    // 正因如此 excerptMatcher.ts 才需要 flatten(source).text.replace(/\s+$/, '')
    expect(flat.text).toBe('标题\n被告的行为构成根本违约。\n');
    // NormalizedText 契约：末尾哨兵
    expect(flat.map).toHaveLength(flat.text.length + 1);
  });
});

describe('matchExcerpt().text —— 错误发生的那一行（toResult）', () => {
  it('★ 展示文本剥掉语法标记，引用字段 source 保持源码原样', async () => {
    const doc = '前言。\n\n**被告**的行为已经构成根本违约。';
    const r = await matchExcerpt('被告的行为已经构成根本违约。', doc, { markdown: md, fallbacks: [] });

    expect(r.found).toBe(true);
    // 引用该引源码：** 成对保留（excerptMatcher.ts 的契约）
    expect(r.source).toBe('**被告**的行为已经构成根本违约。');
    expect(r.source).toBe(doc.slice(r.index, r.index + r.length));
    // 展示用的可见文本：flatten(source).text —— 就是当初报 .text 不存在的那条链
    expect(r.text).toBe('被告的行为已经构成根本违约。');
    expect(r.text).not.toContain('*');
  });

  it('★ 单块整段命中：摊平追加的块分隔符换行被修剪，source 不动', async () => {
    const doc = '# 唯一的标题';
    const r = await matchExcerpt('唯一的标题', doc, { markdown: md, fallbacks: [] });

    expect(r.found).toBe(true);
    // 对片段单独摊平会带尾换行（块分隔符）——toResult 必须 replace(/\s+$/, '')
    expect(r.text).toBe('唯一的标题');
    expect(r.text).not.toMatch(/\s$/);
  });

  it('纯文本模式（markdown: null）：text 与 source 同为原文切片', async () => {
    const doc = '第一行 **不是** 强调';
    const r = await matchExcerpt('第一行 **不是** 强调', doc, { markdown: null, fallbacks: [] });

    expect(r.found).toBe(true);
    expect(r.text).toBe(r.source);
    expect(r.text).toBe(doc.slice(r.index, r.index + r.length));
  });

  it('未命中：text / source 为空串，line 为 -1', async () => {
    const r = await matchExcerpt('完全不存在的句子abc', '前言。\n\n正文内容。', {
      markdown: md,
      fallbacks: [],
    });
    expect(r.found).toBe(false);
    expect(r.text).toBe('');
    expect(r.source).toBe('');
    expect(r.line).toBe(-1);
  });
});
