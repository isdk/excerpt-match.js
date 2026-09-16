import { describe, expect, it } from 'vitest';
import { createTextIndex, createPageIndex, locateExcerpt } from './index';

const PAGE = '本院认为，被告的行为已经构成根本违约。\n\n另有一段无关内容。';

describe('createTextIndex 命名', () => {
  it('新名可用', () => {
    const idx = createTextIndex(PAGE, { preset: 'strict' });
    expect(idx.locate('被告的行为').kind).toBe('exact');
  });

  it('★ 旧名仍可用（不破坏已有调用）', () => {
    expect(createPageIndex).toBe(createTextIndex);
    expect(createPageIndex(PAGE).locate('被告的行为').kind).toBe('exact');
  });

  it('★ 复用索引与单次查询结果一致', () => {
    const idx = createTextIndex(PAGE);
    const viaIndex = idx.locate('被告的行为');
    const direct = locateExcerpt('被告的行为', PAGE);
    expect(viaIndex.index).toBe(direct.index);
    expect(viaIndex.length).toBe(direct.length);
  });

  it('索引暴露 raw / text / blocks', () => {
    const idx = createTextIndex(PAGE);
    expect(idx.raw).toBe(PAGE);
    expect(typeof idx.text).toBe('string');
    expect(Array.isArray(idx.blocks)).toBe(true);
  });
});
