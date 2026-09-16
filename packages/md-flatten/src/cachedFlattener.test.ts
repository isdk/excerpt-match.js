import { describe, expect, it } from 'vitest';
import { createCachedFlattener } from './cachedFlattener';
import type { FlatResult, MarkdownFlattener } from './markdown';

/** 替身：记录真实解析次数，无需真 mdast */
function stub(): { flattener: MarkdownFlattener; calls: () => number } {
  let n = 0;
  const flattener: MarkdownFlattener = {
    flatten(src: string): FlatResult {
      n++;
      return { text: src.replace(/[*_]/g, ''), map: [], mapEnd: [], back: [], blocks: [] } as unknown as FlatResult;
    },
  };
  return { flattener, calls: () => n };
}

const DOC = '# 标题\n\n本院**认为**被告违约。';

describe('缓存生效', () => {
  it('★ 相同文档只解析一次（跨两个 index 也共享）', () => {
    const { flattener, calls } = stub();
    const md = createCachedFlattener(flattener);
    md.flatten(DOC);
    md.flatten(DOC);
    expect(calls()).toBe(1);
  });

  it('不同文档各自解析', () => {
    const { flattener, calls } = stub();
    const md = createCachedFlattener(flattener);
    md.flatten(DOC);
    md.flatten(DOC + '另一段');
    expect(calls()).toBe(2);
  });
});

describe('★ docId 优先，回退全文', () => {
  it('flattenById 用 id 作 key，不依赖全文', () => {
    const { flattener, calls } = stub();
    const md = createCachedFlattener(flattener);
    md.flattenById(DOC, 'doc-1');
    md.flattenById(DOC, 'doc-1');
    expect(calls()).toBe(1);
  });

  it('★ 同 id 不同内容会命中旧缓存（文档化的取舍）', () => {
    // 这是刻意的：docId 相同就意味着内容相同。
    // 若同一 id 下内容会变，请传 undefined 走全文，或换 id。
    const { flattener } = stub();
    const md = createCachedFlattener(flattener);
    const a = md.flattenById(DOC, 'doc-1');
    const b = md.flattenById('完全不同的内容', 'doc-1');
    expect(b.text).toBe(a.text);
  });

  it('docIdOf 提取到 id → 用它', () => {
    const { flattener, calls } = stub();
    const md = createCachedFlattener(flattener, {
      docIdOf: (src) => /^id:(\S+)/m.exec(src)?.[1],
    });
    md.flatten(`id:abc\n${DOC}`);
    md.flatten(`id:abc\n${DOC}`);
    expect(calls()).toBe(1);
  });

  it('★ docIdOf 返回 undefined → 回退全文', () => {
    const { flattener, calls } = stub();
    const md = createCachedFlattener(flattener, { docIdOf: () => undefined });
    md.flatten(DOC);
    md.flatten(DOC);
    expect(calls()).toBe(1); // 仍然缓存，只是 key 是全文
  });

  it('★ id 键与全文键不会碰撞', () => {
    // 某文档内容恰好等于另一个文档的 id —— 加前缀避免串味
    const { flattener, calls } = stub();
    const md = createCachedFlattener(flattener);
    md.flattenById('内容A', 'docX');
    md.flatten('docX'); // 全文恰好是 'docX'
    expect(calls()).toBe(2);
  });
});

describe('运维接口', () => {
  it('size 反映条目数，clear 清空', () => {
    const { flattener, calls } = stub();
    const md = createCachedFlattener(flattener);
    expect(md.size).toBe(0);
    md.flattenById(DOC, 'a');
    md.flattenById(DOC + '2', 'b');
    expect(md.size).toBe(2);
    md.clear();
    expect(md.size).toBe(0);
    md.flattenById(DOC, 'a');
    expect(calls()).toBe(3); // 清空后重新解析
  });
});
