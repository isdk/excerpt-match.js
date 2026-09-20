import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener } from '@isdk/md-flatten';
import { createDmpFallback } from './fuzzyMatch';
import type { SemanticRetriever } from './semanticMatch';
import { createExcerptMatcher, matchExcerpt } from './excerptMatcher';
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
 * 迁移前的实现（原样保留）—— 用它做对照，说明本库补上了什么。
 * 手搓版的三个毛病在这里都会被复现：不认 md 语法、不认标点差异、段序不校验。
 */
function legacyIsExcerptOfDoc(excerpt: string, doc: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const e = norm(excerpt ?? '');
  const p = norm(doc ?? '');
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
// 显式 fallbacks: []：只考察 T4 语义层本身，不让内置默认模糊层（diff-match-patch-es）抢先命中
const T4 = { markdown: md, retriever: lexicalRetriever, aligner: dmp, fallbacks: [] } as const;

describe('matchExcerpt：真实长文（React 18 新特性）上的迁移收益', () => {
  it('★ md 语法不再是障碍，且返回的是可引用的真实原文', async () => {
    const ex = 'React 18 通过在默认情况下执行批处理来实现了开箱即用的性能改进。';
    // 源码里这段是「`React 18` 通过在默认…」，手搓版把反引号当字面内容 → 漏判
    expect(legacyIsExcerptOfDoc(ex, DOC)).toBe(false);

    const r = await matchExcerpt(ex, DOC, { markdown: md });
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
    expect(legacyIsExcerptOfDoc(ex, DOC)).toBe(false);
    // 显式关掉内置默认模糊层，单独考察标点开关 —— 否则默认模糊层可能兜住这种近差异
    expect((await matchExcerpt(ex, DOC, { markdown: md, fallbacks: [] })).found).toBe(false); // 默认不跨标点

    const r = await matchExcerpt(ex, DOC, { markdown: md, ignorePunctuation: true });
    expect(r.found).toBe(true);
    expect(r.kind).toBe('normalized');
    expect(r.punctFolded).toBe(true); // 统一结果带上严格性元数据
    expect(r.source).toContain('flushSync');
    expect(DOC.slice(r.index, r.index + r.length)).toBe(r.source);
  });

  it('T4：标题词注入正文句（useInsertionEffect）', async () => {
    const ex = 'useInsertionEffect 这个 Hooks 执行时机在 DOM 生成之后，useLayoutEffect 之前，它的工作原理大致和 useLayoutEffect 相同，只是此时无法访问 DOM 节点的引用，一般用于提前注入 <style> 脚本。';
    expect(legacyIsExcerptOfDoc(ex, DOC)).toBe(false);
    // 关掉默认模糊层：T0–T2 够不到，才能暴露「这条摘录需要 T4」
    expect((await matchExcerpt(ex, DOC, { markdown: md, fallbacks: [] })).found).toBe(false);

    const r = await matchExcerpt(ex, DOC, T4);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('semantic');
    expect(r.line).toBe(469);
    expect(r.source).toContain('这个 Hooks 执行时机在 `DOM` 生成之后');
  });

  it('T4：跨小节归纳（startTransition + useDeferredValue）', async () => {
    const ex = 'startTransition，主要为了能在大量的任务下也能保持 UI 响应。useDeferredValue 返回一个延迟响应的值，可以让一个 state 延迟生效，只有当前没有紧急更新时，该值才会变为最新值。';
    expect(legacyIsExcerptOfDoc(ex, DOC)).toBe(false);

    const r = await matchExcerpt(ex, DOC, T4);
    expect(r.found).toBe(true);
    // 召回落在标题「二、useDeferredValue」所在段 —— 标题就是原文
    expect(r.source).toContain('二、useDeferredValue');
    expect(r.source).toEqual(DOC.slice(r.index, r.index + r.length));
  });

  it('T3 与 T4 可叠加：fallbacks 命中即停，未命中才动用召回', async () => {
    const ex = '本院认为，被告的行为构成违约'; // 缺了「已经」二字，T0–T2 够不到
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const retriever = vi.fn(lexicalRetriever);
    const r = await matchExcerpt(ex, doc, {
      fallbacks: [dmp],
      retriever,
      aligner: dmp,
    });
    // T3 已命中 → 不必动用召回器
    expect(r.found).toBe(true);
    expect(r.kind).toBe('fuzzy');
    expect(retriever).not.toHaveBeenCalled();
  });

  it('minScore 只约束 T3/T4 —— 未达标按未命中处理', async () => {
    const ex = '本院认为，被告的行为构成违约';
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const ok = await matchExcerpt(ex, doc, { fallbacks: [dmp], minScore: 0.5 });
    const strict = await matchExcerpt(ex, doc, { fallbacks: [dmp], minScore: 1 });
    expect(ok.found).toBe(true);
    expect(strict.found).toBe(false); // T3 分数低于门槛 → 判未命中
  });

  it('未命中时 found=false、source 为空串，且 kind/score 保留判定信息', async () => {
    const r = await matchExcerpt('本文档压根没写过这句话。', DOC, { markdown: md, onMiss: () => {} });
    expect(r.found).toBe(false);
    expect(r.source).toBe('');
    expect(r.text).toBe('');
    expect(r.index).toBe(-1);
    expect(r.length).toBe(0);
    expect(r.line).toBe(-1);
    expect(r.kind).toBe('none');
    expect(r.score).toBe(0);
  });
});

describe('迁移后不再制造的假命中', () => {
  const doc = '本院认为，被告构成违约。\n\n综上，本院判决如下：赔偿原告损失。';

  it('★ 省略片段的顺序不做校验 = 手搓版的漏洞', async () => {
    const reversed = '本院判决如下……本院认为，被告构成违约。';
    // 两段都在文档里、长度也够 —— 手搓版只看「存在」，不管先后与相邻
    expect(legacyIsExcerptOfDoc(reversed, doc)).toBe(true);
    // 本库的 T2 是链式锚点：必须按原文顺序命中
    expect((await matchExcerpt(reversed, doc)).found).toBe(false);
  });

  it('顺序正确的省略摘录仍然通过', async () => {
    const r = await matchExcerpt('本院认为，被告构成违约。……综上，本院判决如下', doc);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('segmented');
  });
});

describe('API 形状', () => {
  const ex = '并发模式可帮助应用保持响应，并根据用户的设备性能和网速进行适当的调整，该模式通过使渲染可中断来修复阻塞渲染限制。';

  it('统一结果包含完整定位元数据（含 occurrences）', async () => {
    const r = await matchExcerpt(ex, DOC, { markdown: md });
    expect(r.index).toBeGreaterThan(0);
    expect(r.length).toBeGreaterThan(0);
    expect(r.occurrences).toBe(1);
    expect(DOC.slice(r.index, r.index + r.length)).toContain('并发模式可帮助应用保持响应');
  });

  it('createExcerptMatcher：一次建索引，多条复用', async () => {
    const m = createExcerptMatcher(DOC, { markdown: md });
    const excerpts = [ex, 'React 18 通过在默认情况下执行批处理来实现了开箱即用的性能改进。'];
    for (const e of excerpts) {
      const r = await m.match(e);
      expect(r.found).toBe(true);
      expect(r.source.length).toBeGreaterThan(0);
    }
  });

  it('不给召回器就不碰语义层 —— T4 仅在配置了 retriever 时发生', async () => {
    const m = createExcerptMatcher(DOC, T4);
    const ex = 'useInsertionEffect 这个 Hooks 执行时机在 DOM 生成之后，useLayoutEffect 之前，它的工作原理大致和 useLayoutEffect 相同，只是此时无法访问 DOM 节点的引用，一般用于提前注入 <style> 脚本。';
    // 同一个入口：没配 retriever 的实例走不到语义层（关掉默认模糊层，聚焦 T4 有无）
    const plain = createExcerptMatcher(DOC, { markdown: md, fallbacks: [] });
    expect((await plain.match(ex)).kind).toBe('none');
    expect((await m.match(ex)).kind).toBe('semantic');
  });

  it('onHit / onMiss 回调由 options 配置', async () => {
    const hits: string[] = [];
    const misses: string[] = [];
    const m = createExcerptMatcher(DOC, {
      markdown: md,
      onHit: (e, r) => hits.push(`${e}:${r.kind}`),
      onMiss: (e) => misses.push(e),
    });
    await m.match(ex);
    await m.match('本文档压根没写过这句话。');
    expect(hits).toEqual([`${ex}:exact`]);
    expect(misses).toEqual(['本文档压根没写过这句话。']);
  });

  it('onHit 在 T4 语义命中时同样触发 —— 回调覆盖全部档位', async () => {
    const hits: Array<{ excerpt: string; kind: string; found: boolean }> = [];
    const misses: string[] = [];
    const m = createExcerptMatcher(DOC, {
      ...T4,
      onHit: (e, r) => hits.push({ excerpt: e, kind: r.kind, found: r.found }),
      onMiss: (e) => misses.push(e),
    });
    // 这条摘录 T0–T3 够不到，只有 T4 语义召回能接住（同「不给召回器就不碰语义层」用例）
    const ex = 'useInsertionEffect 这个 Hooks 执行时机在 DOM 生成之后，useLayoutEffect 之前，它的工作原理大致和 useLayoutEffect 相同，只是此时无法访问 DOM 节点的引用，一般用于提前注入 <style> 脚本。';
    const r = await m.match(ex);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('semantic');
    expect(hits).toEqual([{ excerpt: ex, kind: 'semantic', found: true }]);
    expect(misses).toEqual([]); // 命中了就不该触发 onMiss
  });

  it('未命中默认静默 —— 库不该默认往控制台打印', async () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await matchExcerpt('本文档压根没写过这句话。', DOC, { markdown: md });
    expect(r.found).toBe(false);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('空摘录 / 空文本：返回未命中且触发 onMiss', async () => {
    const misses: string[] = [];
    const m = createExcerptMatcher(DOC, { markdown: md, onMiss: (e) => misses.push(e) });
    expect((await m.match('')).found).toBe(false);
    expect(misses).toHaveLength(1);
  });
});

describe('零配置默认：全部依赖内置，不传任何选项也能用', () => {
  it('不传任何选项：内置 md 摊平器接管，返回可引用的源码片段', async () => {
    const ex = 'React 18 通过在默认情况下执行批处理来实现了开箱即用的性能改进。';
    const r = await matchExcerpt(ex, DOC);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('exact');
    // 内置摊平器与显式传入的等价：反引号成对保留，展示文本已剥掉语法标记
    expect(r.source).toBe('`React 18` 通过在默认情况下执行批处理来实现了开箱即用的性能改进。');
    expect(r.text).toBe(ex);
  });

  it('默认模糊层（diff-match-patch-es）：漏两个字也能命中', async () => {
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const r = await matchExcerpt('本院认为，被告的行为构成违约', doc);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('fuzzy');
    expect(r.via).toBe('diff-match-patch-es');
  });

  it('strict 档不注入默认模糊层 —— 宁可漏，不可错', async () => {
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const r = await matchExcerpt('本院认为，被告的行为构成违约', doc, { preset: 'strict' });
    expect(r.found).toBe(false);
  });

  it('显式 fallbacks: [] 在任何档位都能关掉模糊层', async () => {
    const doc = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const r = await matchExcerpt('本院认为，被告的行为构成违约', doc, { fallbacks: [] });
    expect(r.found).toBe(false);
  });

  it('markdown: null 强制纯文本 —— ** 是字面内容而不是语法', async () => {
    const doc = '这里的 **不是** 语法标记，而是字面星号';
    const r = await matchExcerpt('**不是**', doc, { markdown: null });
    expect(r.found).toBe(true);
    expect(r.kind).toBe('exact');
    expect(r.source).toBe('**不是**');
  });

  it('cjkNumerals: true 即用内置 cjk-number 解析器', async () => {
    const doc = '本金一千元整，利息照付。';
    const r = await matchExcerpt('本金1000元整', doc, { cjkNumerals: true, fallbacks: [] });
    expect(r.found).toBe(true);
    expect(r.kind).toBe('normalized');
  });

  it('ignoreParticles: true 自动升级为内置 jieba 词性判定（关掉模糊层以隔离验证）', async () => {
    const doc = '他高兴地接受了邀请。';
    // 「地」与「的」不同字：不开助词折叠 T0–T2 必不命中，fuzzy 也已显式关闭
    const r = await matchExcerpt('他高兴的接受', doc, { ignoreParticles: true, fallbacks: [] });
    expect(r.found).toBe(true);
  });
});
