/**
 * T4 语义层（主包坐标版）的契约测试。
 *
 * 这里只测**本包自己的职责**：坐标翻译与选项一致性。
 * 召回与段内对齐的编排由 `@isdk/semantic-locate` 负责，那边另有测试。
 *
 * 两个最容易出错、也必须钉死的地方：
 * 1. 摘录必须用**与页面同一套**归一化选项，否则两边不在同一个空间里
 * 2. 交给 aligner 的 `NormalizedText` 必须是**该段的切片**，
 *    不能把整页的 `map` 原样塞进去（下标会错位）
 */

import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createTextIndex } from './index';
import { createMdastFlattener } from '@isdk/md-flatten';
import { locateSemantic } from './semanticMatch';
import type { SemanticRetriever } from './semanticMatch';
import type { Candidate, FallbackMatcher, NormalizedText } from './types';

const md = createMdastFlattener(fromMarkdown, {
  extensions: [gfm()],
  mdastExtensions: [gfmFromMarkdown()],
});

/** 所有段落等分，保证都会被召回（本文件测的不是排序） */
const allSegments: SemanticRetriever = (_excerpt, segments) =>
  segments.map((_s, index) => ({ index, score: 1 - index * 0.01 }));

/** 收集 aligner 每次实际拿到的参数 */
interface Seen {
  needle: string;
  text: string;
  map0: number;
  mapLen: number;
}
function recording(): { matcher: FallbackMatcher; seen: Seen[] } {
  const seen: Seen[] = [];
  const matcher: FallbackMatcher = {
    name: 'recorder',
    kind: 'fuzzy',
    find(needle: string, hay: NormalizedText): Candidate[] | null {
      seen.push({ needle, text: hay.text, map0: hay.map[0], mapLen: hay.map.length });
      const at = hay.text.indexOf(needle);
      return at >= 0 ? [{ start: at, end: at + needle.length, score: 1 }] : null;
    },
  };
  return { matcher, seen };
}

describe('★ T4 摘录侧必须用与页面相同的归一化选项', () => {
  const PAGE = '本院认为，被告构成违约，应当承担赔偿责任。';

  it('★ 页面开了 ignorePunctuation 时，摘录也要跟着折叠', async () => {
    const idx = createTextIndex(PAGE, { ignorePunctuation: true });
    const { matcher, seen } = recording();

    const hit = await locateSemantic(idx, '本院认为，被告构成违约', allSegments, {
      aligner: matcher,
    });

    expect(seen.length).toBeGreaterThan(0);
    // 全角逗号被折成占位符，且 CJK 之间的占位符会被删掉
    expect(seen[0].needle).toBe('本院认为被告构成违约');
    // 只有两边同空间才能对齐成功；若摘录另用一套选项，这里会退化成 segment
    expect(hit.via).toBe('semantic');
    expect(hit.kind).toBe('semantic');
  });

  it('关闭 ignorePunctuation 时，标点只做宽度折叠、不被删除', async () => {
    const idx = createTextIndex(PAGE, { ignorePunctuation: false });
    const { matcher, seen } = recording();

    await locateSemantic(idx, '本院认为，被告构成违约', allSegments, { aligner: matcher });

    expect(seen[0].needle).toBe('本院认为,被告构成违约');
  });

  it('★ 未开该选项时页面侧保留标点，两者仍然同空间', async () => {
    const idx = createTextIndex(PAGE, { ignorePunctuation: false });
    const { matcher } = recording();
    const hit = await locateSemantic(idx, '本院认为，被告构成违约', allSegments, {
      aligner: matcher,
    });
    expect(hit.via).toBe('semantic');
  });
});

/** 目标词落在**第二段**，且 md 模式下源码坐标与可见文本坐标不相等 */
const SRC = [
  '# 标题',
  '',
  '第一段内容平平。',
  '',
  '第二段含有**目标词**。',
  '',
  '第三段同样平平。',
].join('\n');

describe('★ 交给 aligner 的 NormalizedText 必须是该段的切片', () => {
  it('★ map 的起点必须是该段在整页中的源码下标（不是整页起点）', async () => {
    const idx = createTextIndex(SRC, { markdown: md });
    const { matcher, seen } = recording();

    await locateSemantic(idx, '目标词', allSegments, { aligner: matcher });

    expect(seen.length).toBeGreaterThan(0);
    for (const s of seen) {
      // 该段在归一化文本中的起点
      const segStart = idx.norm.text.indexOf(s.text);
      expect(segStart).toBeGreaterThanOrEqual(0);
      // 切片的 map[0] 必须指向这一段的源码起点
      expect(s.map0).toBe(idx.norm.map[segStart]);
    }
    // 至少有一段不是从 0 开始，否则这个测试证明不了任何事情
    expect(seen.some((s) => s.map0 > 0)).toBe(true);
  });

  it('★ 切片长度与文本长度一致（含末尾哨兵）', async () => {
    const idx = createTextIndex(SRC, { markdown: md });
    const { matcher, seen } = recording();

    await locateSemantic(idx, '目标词', allSegments, { aligner: matcher });

    for (const s of seen) {
      expect(s.mapLen).toBe(s.text.length + 1);
    }
  });

  it('★ 纯文本模式下同样成立', async () => {
    const page = '第一段内容平平。第二段含有目标词。第三段同样平平。';
    const idx = createTextIndex(page);
    const { matcher, seen } = recording();

    await locateSemantic(idx, '目标词', allSegments, { aligner: matcher });

    for (const s of seen) {
      const segStart = idx.norm.text.indexOf(s.text);
      expect(s.map0).toBe(idx.norm.map[segStart]);
    }
    expect(seen.some((s) => s.map0 > 0)).toBe(true);
  });
});

describe('★ 检索器上下文：语言与分词器要真的传下去', () => {
  it('★ 中文页面把 locale 与字级分词传给检索器', async () => {
    const idx = createTextIndex('本院认为被告构成根本违约。');
    let seenLocale: string | undefined;
    let seenTokens: string[] | undefined;

    const spy: SemanticRetriever = (excerpt, segments, ctx) => {
      seenLocale = ctx.locale;
      seenTokens = ctx.tokenize?.(excerpt);
      return segments.map((_s, index) => ({ index, score: 1 - index * 0.1 }));
    };

    await locateSemantic(idx, '根本违约', spy);

    expect(seenLocale).toBe('cjk');
    expect(seenTokens).toEqual(Array.from('根本违约'));
  });
});

describe('T4 未命中与降级', () => {
  it('全部对齐失败 → 整段命中并降级为 semantic:segment', async () => {
    const idx = createTextIndex('第一段内容平平。第二段含有目标词。');
    const never: FallbackMatcher = {
      name: 'never',
      kind: 'fuzzy',
      find: () => null,
    };
    const hit = await locateSemantic(idx, '目标词', allSegments, { aligner: never });
    expect(hit.kind).toBe('semantic');
    expect(hit.via).toBe('semantic:segment');
    expect(hit.score).toBeLessThan(1);
  });

  it('★ 命中坐标可回切到源码', async () => {
    const idx = createTextIndex(SRC, { markdown: md });
    const { matcher } = recording();
    const hit = await locateSemantic(idx, '目标词', allSegments, { aligner: matcher });
    expect(hit.kind).toBe('semantic');
    // 源码片段应含目标词（md 模式下含标记，故用 includes 而非相等）
    expect(SRC.slice(hit.index, hit.index + hit.length)).toContain('目标词');
  });
});
