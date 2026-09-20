import { describe, expect, it } from 'vitest';
import { createTextIndex, locateExcerpt } from './index';

const TEXT = '本院认为，被告的行为已经构成根本违约。\n\n另有一段无关内容。';

describe('createTextIndex 命名', () => {
  it('新名可用', () => {
    const idx = createTextIndex(TEXT, { preset: 'strict' });
    expect(idx.locate('被告的行为').kind).toBe('exact');
  });

  it('★ 复用索引与单次查询结果一致', () => {
    const idx = createTextIndex(TEXT);
    const viaIndex = idx.locate('被告的行为');
    const direct = locateExcerpt('被告的行为', TEXT);
    expect(viaIndex.index).toBe(direct.index);
    expect(viaIndex.length).toBe(direct.length);
  });

  it('索引暴露 raw / text / blocks', () => {
    const idx = createTextIndex(TEXT);
    expect(idx.raw).toBe(TEXT);
    expect(typeof idx.text).toBe('string');
    expect(Array.isArray(idx.blocks)).toBe(true);
  });
});
