import { describe, expect, it } from 'vitest';
import { createGuardListParticleTagger, createJiebaParticleTagger, PARTICLES, SOLID_WORDS } from './chineseParticles';
import type { JiebaLike } from './chineseParticles';

let jieba: JiebaLike | null = null;
try {
  jieba = (await import(/* @vite-ignore */ '@isdk/nlp-jieba')) as unknown as JiebaLike;
} catch {
  jieba = null;
}

/**
 * 判定器的契约是 `foldableAt(text): ReadonlySet<number>` ——
 * 返回**可折叠的字符下标集合**，而不是逐字符查询。
 * 这样它只需要分词一次，而不是每个位置各分一次。
 */
describe('内置保守模式（实词保护表）', () => {
  const tagger = createGuardListParticleTagger();

  it('助词可被折叠', () => {
    const fold = tagger.foldableAt('他高兴地接受了这份合同');
    expect(fold.has(3)).toBe(true); // 「地」是助词
  });

  it('★ 实词里的「地/得」不被折叠', () => {
    // 这些是实词的一部分，不是助词
    expect(tagger.foldableAt('辽阔的大地').has(4)).toBe(false);
    expect(tagger.foldableAt('这片土地').has(3)).toBe(false);
    expect(tagger.foldableAt('他得到了批准').has(2)).toBe(false);
    expect(tagger.foldableAt('详细地址').has(3)).toBe(false);
  });

  it('常量表可检查', () => {
    expect(PARTICLES.has('的')).toBe(true);
    expect(PARTICLES.has('地')).toBe(true);
    expect(PARTICLES.has('得')).toBe(true);
    expect(SOLID_WORDS.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!jieba)('jieba 精确判定', () => {
  const tagger = jieba ? createJiebaParticleTagger(jieba) : null;

  it('助词混用 → 可折叠', () => {
    // jieba 把「高兴地」切成 高兴/b 地/uv，地 是独立助词
    const fold = tagger!.foldableAt('他高兴地接受了这份合同');
    expect(fold.has(3)).toBe(true);
  });

  it('实词 → 不可折叠', () => {
    // jieba 把「土地」切成 土地/n，「地」不是独立 token
    expect(tagger!.foldableAt('这片土地').has(3)).toBe(false);
    expect(tagger!.foldableAt('他得到了批准').has(2)).toBe(false);
  });
});
