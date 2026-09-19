import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener } from '@isdk/md-flatten';
import { createDmpFallback } from './fuzzyMatch';
import type { SemanticRetriever } from './semanticMatch';
import { createExcerptVerifier, verifyExcerptFromPage, locateExcerptFromPage } from './excerptVerifier';
import { diff_match_patch } from 'diff-match-patch';

const md = createMdastFlattener(fromMarkdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
}) as never;

const DOC = readFileSync(
  join(__dirname, '..', 'test', 'fixtures', 'md-article-feature-summaries', 'doc.md'),
  'utf8'
);

/**
 * 迁移前的实现（原样保留）—— 用它做对照，说明校验器补上了什么。
 * 手搓版的三个毛病在这里都会被复现：不认 md 语法、不认标点差异、段序不校验。
 */
function legacyIsExcerptFromPage(excerpt: string, pageContent: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const e = norm(excerpt ?? '');
  const p = norm(pageContent ?? '');
  if (!(e && p)) return false;
  if (p.includes(e)) return true;
  const fragments = e.split(/\.{3}|…/).map((f) => f.trim()).filter((f) => f.length > 0);
  if (fragments.length === 0) return false;
  if (fragments.length === 2 && fragments.every((f) => p.includes(f))) return true;
  const hasLongEnough = fragments.some((f) => f.length >= 10);
  return hasLongEnough && fragments.every((f) => p.includes(f));
}

/** 确定性的「假召回器」—— 与 test/capabilities.ts 同款，按字符重叠给段落打分 */
const lexicalRetriever: SemanticRetriever = (excerpt, segments) =>
  segments
    .map((text, index) => {
      let common = 0;
      for (const ch of excerpt) if (text.includes(ch)) common += 1;
      return { index, score: common / Math.max(1, excerpt.length) };
    })
    .filter((s) => s.score > 0);

const dmp = createDmpFallback(new diff_match_patch());
const T4 = { markdown: md, retriever: lexicalRetriever, aligner: dmp } as const;

describe('verifyExcerptFromPage：真实长文（React 18 新特性）上的迁移收益', () => {
  it('★ md 语法不再是障碍，且返回的是可引用的真实原文', async () => {
    const ex = 'React 18 通过在默认情况下执行批处理来实现了开箱即用的性能改进。';
    // 源码里这段是「`React 18` 通过在默认…」，手搓版把反引号当字面内容 → 漏判
    expect(legacyIsExcerptFromPage(ex, DOC)).toBe(false);

    const r = await verifyExcerptFromPage(ex, DOC, { markdown: md });
    expect(r.found).toBe(true);
    expect(r.kind).toBe('exact');
    // 真实原文：坐标切片即源码片段，反引号成对保留（引用该引的是源码）
    expect(r.source).toBe(DOC.slice(r.index, r.index + r.length));
    expect(r.source).toBe('`React 18` 通过在默认情况下执行批处理来实现了开箱即用的性能改进。');
    expect(r.text).toBe(ex); // 展示用的可见文本已剥掉语法标记
    expect(r.line).toBe(152);
  });

  it('★ 尾部标点差异（`：` vs `。`）：手搓版漏判，本库按开关跨界', async () => {
    const ex = '批处理是一个破坏性改动，如果你想退出批量更新，你可以使用 flushSync。';
    expect(legacyIsExcerptFromPage(ex, DOC)).toBe(false);
    expect((await verifyExcerptFromPage(ex, DOC, { markdown: md })).found).toBe(false); // 默认不跨标点

    const r = await verifyExcerptFromPage(ex, DOC, { markdown: md, ignorePunctuation: true });
    expect(r.found).toBe(true);
    expect(r.kind).toBe('normalized');
    expect(r.source).toContain('flushSync');
    expect(DOC.slice(r.index, r.index + r.length)).toBe(r.source);
  });

  it('T4：标题词注入正文句（useInsertionEffect）', async () => {
    const ex = 'useInsertionEffect 这个 Hooks 执行时机在 DOM 生成之后，useLayoutEffect 之前，它的工作原理大致和 useLayoutEffect 相同，只是此时无法访问 DOM 节点的引用，一般用于提前注入 <style> 脚本。';
    expect(legacyIsExcerptFromPage(ex, DOC)).toBe(false);
    expect((await verifyExcerptFromPage(ex, DOC, { markdown: md })).found).toBe(false); // T0–T3 够不到

    const r = await verifyExcerptFromPage(ex, DOC, T4);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('semantic');
    expect(r.line).toBe(469);
    expect(r.source).toContain('这个 Hooks 执行时机在 `DOM` 生成之后');
  });

  it('T4：跨小节归纳（startTransition + useDeferredValue）', async () => {
    const ex = 'startTransition，主要为了能在大量的任务下也能保持 UI 响应。useDeferredValue 返回一个延迟响应的值，可以让一个 state 延迟生效，只有当前没有紧急更新时，该值才会变为最新值。';
    expect(legacyIsExcerptFromPage(ex, DOC)).toBe(false);

    const r = await verifyExcerptFromPage(ex, DOC, T4);
    expect(r.found).toBe(true);
    // 召回落在标题「二、useDeferredValue」所在段 —— 标题就是原文
    expect(r.source).toContain('二、useDeferredValue');
    expect(r.source).toEqual(DOC.slice(r.index, r.index + r.length));
  });

  it('未命中时 found=false、source 为空串', async () => {
    const r = await verifyExcerptFromPage('本页压根没写过这句话。', DOC, { markdown: md, onMiss: () => {} });
    expect(r.found).toBe(false);
    expect(r.source).toBe('');
    expect(r.index).toBe(-1);
    expect(r.length).toBe(0);
    expect(r.line).toBe(-1);
  });
});

describe('迁移后不再制造的假命中', () => {
  const page = '本院认为，被告构成违约。\n\n综上，本院判决如下：赔偿原告损失。';

  it('★ 省略片段的顺序不做校验 = 手搓版的漏洞', async () => {
    const reversed = '本院判决如下……本院认为，被告构成违约。';
    // 两段都在页面里、长度也够 —— 手搓版只看「存在」，不管先后与相邻
    expect(legacyIsExcerptFromPage(reversed, page)).toBe(true);
    // 本库的 T2 是链式锚点：必须按原文顺序命中
    expect((await verifyExcerptFromPage(reversed, page)).found).toBe(false);
  });

  it('顺序正确的省略摘录仍然通过', async () => {
    const r = await verifyExcerptFromPage('本院认为，被告构成违约。……综上，本院判决如下', page);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('segmented');
  });
});

describe('API 形状', () => {
  const ex = '并发模式可帮助应用保持响应，并根据用户的设备性能和网速进行适当的调整，该模式通过使渲染可中断来修复阻塞渲染限制。';

  it('locateExcerptFromPage 只要坐标与元数据', async () => {
    const m = await locateExcerptFromPage(ex, DOC, { markdown: md });
    expect(m.index).toBeGreaterThan(0);
    expect(m.length).toBeGreaterThan(0);
    expect(DOC.slice(m.index, m.index + m.length)).toContain('并发模式可帮助应用保持响应');
  });

  it('createExcerptVerifier：一次建索引，多条复用', async () => {
    const v = createExcerptVerifier(DOC, { markdown: md });
    const excerpts = [ex, 'React 18 通过在默认情况下执行批处理来实现了开箱即用的性能改进。'];
    for (const e of excerpts) {
      const r = await v.check(e);
      expect(r.found).toBe(true);
      expect(r.source.length).toBeGreaterThan(0);
    }
  });

  it('同步的 verify 只走 T0–T3 —— 不给召回器就不碰语义层', async () => {
    const v = createExcerptVerifier(DOC, T4);
    const ex = 'useInsertionEffect 这个 Hooks 执行时机在 DOM 生成之后，useLayoutEffect 之前，它的工作原理大致和 useLayoutEffect 相同，只是此时无法访问 DOM 节点的引用，一般用于提前注入 <style> 脚本。';
    expect(v.verify(ex).kind).toBe('none');
    expect((await v.verifyAsync(ex)).kind).toBe('semantic');
  });

  it('未命中默认 warn', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await verifyExcerptFromPage('本页压根没写过这句话。', DOC, { markdown: md })).found).toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('onMiss 可替换掉默认 warn', async () => {
    const seen: string[] = [];
    await verifyExcerptFromPage('本页压根没写过这句话。', DOC, { markdown: md, onMiss: (e) => seen.push(e) });
    expect(seen).toHaveLength(1);
  });
});
