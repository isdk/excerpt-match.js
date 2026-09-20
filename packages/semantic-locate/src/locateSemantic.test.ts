import { describe, expect, it } from 'vitest';
import { locateSemantic, normalizeScores } from './locateSemantic';
import type { SemanticRetriever } from './types';

/** 检索替身：按「包含多少个摘录字符」打分 —— 无需真 embedding 也能测编排 */
const keywordRetriever: SemanticRetriever = (excerpt, segments) =>
  segments
    .map((s, index) => {
      const chars = new Set(excerpt);
      let hit = 0;
      for (const c of s) if (chars.has(c)) hit++;
      return { index, score: Math.min(1, hit / Math.max(1, excerpt.length)) };
    })
    .filter((r) => r.score > 0);

/** 对齐替身：段内精确查找，找不到就返回 null */
const exactAligner = (excerpt: string, seg: string) => {
  const at = seg.indexOf(excerpt);
  return at >= 0 ? { start: at, end: at + excerpt.length, score: 1 } : null;
};

const DOC = '本院认为，被告的行为已经构成根本违约。应当承担赔偿责任。另有一段无关内容。';

describe('两阶段定位', () => {
  it('★ 精确命中段落并换算成整页偏移', async () => {
    const hit = await locateSemantic(DOC, '根本违约', keywordRetriever, {
      aligner: exactAligner,
      minRecallScore: 0.1,
    });
    expect(hit).not.toBeNull();
    expect(hit!.via).toBe('aligned');
    expect(DOC.slice(hit!.start, hit!.end)).toBe('根本违约');
  });

  it('★ 无 aligner 时降级为整段并降分', async () => {
    const hit = await locateSemantic(DOC, '根本违约', keywordRetriever, {
      minRecallScore: 0.1,
    });
    expect(hit).not.toBeNull();
    expect(hit!.via).toBe('segment');
    // 降分：0.9 倍
    expect(hit!.score).toBeLessThan(1);
  });

  it('★ 对齐失败也降级为整段', async () => {
    const neverAlign = () => null;
    const hit = await locateSemantic(DOC, '根本违约', keywordRetriever, {
      aligner: neverAlign,
      minRecallScore: 0.1,
    });
    expect(hit!.via).toBe('segment');
  });

  it('分数取召回与对齐的较小值（保守）', async () => {
    const weakAligner = (_e: string, s: string) => ({ start: 0, end: s.length, score: 0.65 });
    const hit = await locateSemantic(DOC, '根本违约', keywordRetriever, {
      aligner: weakAligner,
      minRecallScore: 0.1,
    });
    expect(hit!.score).toBeLessThanOrEqual(0.65);
  });
});

/**
 * BM25 式替身：**无上界**，但与相关性正相关。
 *
 * 用它验证"召回分不参与数值混合" —— 这类分数一旦与对齐分做
 * `Math.min` 或钳制到 [0,1]，语义就会被悄悄扭曲。
 */
const bm25Like: SemanticRetriever = (excerpt, segments) =>
  segments.map((s, index) => ({
    index,
    score: 12.5 + (s.includes(excerpt) ? 100 : 0),
  }));

describe('★ score 语义：召回分只排序，不参与数值混合', () => {
  it('aligned 时 score 就是对齐分（不受无界召回分影响）', async () => {
    // BM25 式无界分数：12.5。若与对齐分混合取 min，结果仍是 0.87 ——
    // 说明召回分根本没起作用；若钳制则会把它伪装成 1.0 的"完美命中"
    const hit = await locateSemantic(DOC, '根本违约', bm25Like, {
      aligner: exactAligner,
      minRecallScore: 0.1,
    });
    expect(hit!.via).toBe('aligned');
    expect(hit!.score).toBe(1); // exactAligner 给 1，不被 12.5/112.5 污染
  });

  it('★ 召回分低但对齐成功 → 仍用对齐分（顺序才是召回的职责）', async () => {
    const lowRecall: SemanticRetriever = (_e, segments) =>
      segments.map((_s, index) => ({ index, score: 0.2 }));
    const hit = await locateSemantic(DOC, '根本违约', lowRecall, {
      aligner: exactAligner,
      minRecallScore: 0.1,
    });
    expect(hit!.score).toBe(1);
  });

  it('★ segment 降级时 score 落在 0~1，且暴露 rank 与原始分', async () => {
    const hit = await locateSemantic(DOC, '根本违约', bm25Like, { minRecallScore: 0.1 });
    expect(hit!.via).toBe('segment');
    expect(hit!.score).toBeGreaterThanOrEqual(0);
    expect(hit!.score).toBeLessThanOrEqual(1);
    // 原始分如实保留，未被钳制篡改
    expect(hit!.recallScore).toBeGreaterThan(12);
    expect(hit!.recallRank).toBe(0);
  });

  it('★ recallRank 是跨实现可比的（rank 0 才是排序信号）', async () => {
    // 两种量纲完全不同的检索器，位次语义一致
    const cosineLike: SemanticRetriever = (excerpt, segments) =>
      segments.map((s, index) => ({
        index,
        score: 0.9 - (s.includes(excerpt) ? 0 : 0.5),
      }));
    const bm25Like2: SemanticRetriever = (excerpt, segments) =>
      segments.map((s, index) => ({
        index,
        score: 100 + (s.includes(excerpt) ? 500 : 0),
      }));
    const a = await locateSemantic(DOC, '根本违约', cosineLike, { minRecallScore: 0.1 });
    const b = await locateSemantic(DOC, '根本违约', bm25Like2, { minRecallScore: 0.1 });
    expect(a!.recallRank).toBe(b!.recallRank);
  });
});

describe('normalizeScores：给 BM25 用户的工具', () => {
  it('min-max 归一化到 0~1', () => {
    expect(normalizeScores([0, 5, 10])).toEqual([0, 0.5, 1]);
  });

  it('★ 全部相同时返回全 1，不除零', () => {
    // 此时位次才是唯一有效信息
    expect(normalizeScores([7, 7, 7])).toEqual([1, 1, 1]);
  });

  it('空数组', () => {
    expect(normalizeScores([])).toEqual([]);
  });

  it('无界分数也被映射到 0~1', () => {
    const r = normalizeScores([12.5, 100, 1000]);
    expect(r[0]).toBe(0);
    expect(r[2]).toBe(1);
  });
});

describe('极性守卫', () => {
  it('★ 语义层尤其需要：相反语义被拒绝', async () => {
    // 余弦相似度分不开「改变世界」与「没在改变世界」，只能靠极性
    const doc = '人工智能正在改变世界，这是事实。';
    const hit = await locateSemantic(doc, '人工智能没在改变世界', keywordRetriever, {
      minRecallScore: 0.1,
    });
    expect(hit).toBeNull();
  });

  it('关掉守卫则命中 —— 证明确实是守卫拦住的', async () => {
    const doc = '人工智能正在改变世界，这是事实。';
    const hit = await locateSemantic(doc, '人工智能没在改变世界', keywordRetriever, {
      minRecallScore: 0.1,
      checkPolarity: false,
    });
    expect(hit).not.toBeNull();
  });

  it('同极性不影响正常召回', async () => {
    const hit = await locateSemantic(DOC, '根本违约', keywordRetriever, {
      minRecallScore: 0.1,
    });
    expect(hit).not.toBeNull();
  });
});

describe('分数契约', () => {
  it('★ 检索器分数无上界时仍被钳到 1（BM25 就没有上界）', async () => {
    const unbounded: SemanticRetriever = (_e, segments) =>
      segments.map((_s, index) => ({ index, score: 2.5 }));
    const hit = await locateSemantic(DOC, '根本违约', unbounded, { minRecallScore: 0.1 });
    expect(hit).not.toBeNull();
    expect(hit!.score).toBeLessThanOrEqual(1);
  });
});

describe('未命中', () => {
  it('召回分数过低 → null', async () => {
    const hit = await locateSemantic(DOC, '完全不相干的内容', keywordRetriever, {
      minRecallScore: 0.99,
    });
    expect(hit).toBeNull();
  });

  it('空文本 → null', async () => {
    expect(await locateSemantic('', 'abc', keywordRetriever)).toBeNull();
  });
});

/**
 * topK 的语义：**前 K 名都要参与对齐**，而不是只试第一名。
 *
 * 召回只负责排序，第 1 名未必是能精确对齐的那一段 ——
 * 所以必须让 topK 个候选依次尝试对齐，全败才退回整段。
 */
describe('★ topK：前 K 名依次尝试对齐', () => {
  /**
   * 三段文本，`splitSegments` 按句号切成 3 段。
   *
   * 两个约束：
   * - 只有**段 1** 含「关键词」——段 0 必须不含，否则第一名就能对齐，测不出缺陷
   * - **不能出现否定词**（如「没有」）——否则段会被极性守卫过滤掉，同样测不到目标
   */
  const DOC3 = '第一段内容平平。第二段含有关键词。第三段同样平平。';

  /** 排序固定为 段0 > 段1 > 段2 */
  const rankByIndexDesc: SemanticRetriever = (_excerpt, segments) =>
    segments.map((_s, index) => ({ index, score: 0.9 - index * 0.1 }));

  /** 只在含「关键词」的段（段 1）内对齐成功 */
  const alignOnlyInMiddle = (excerpt: string, seg: string) => {
    const at = seg.indexOf(excerpt);
    return at >= 0 ? { start: at, end: at + excerpt.length, score: 1 } : null;
  };

  it('★ 第一名对齐失败、第二名成功 → 必须用第二名（aligned）', async () => {
    const hit = await locateSemantic(DOC3, '关键词', rankByIndexDesc, {
      aligner: alignOnlyInMiddle,
      minRecallScore: 0.1,
      topK: 3,
    });
    expect(hit).not.toBeNull();
    // 段 0 不含「关键词」，对齐必失败；段 1 含 —— 必须继续尝试到段 1
    expect(hit!.via).toBe('aligned');
    expect(hit!.segmentIndex).toBe(1);
    expect(hit!.recallRank).toBe(1);
    expect(DOC3.slice(hit!.start, hit!.end)).toBe('关键词');
  });

  it('★ 前三名全部对齐失败 → 才退回整段，且用第一名', async () => {
    const neverAlign = () => null;
    const hit = await locateSemantic(DOC3, '关键词', rankByIndexDesc, {
      aligner: neverAlign,
      minRecallScore: 0.1,
      topK: 3,
    });
    expect(hit!.via).toBe('segment');
    expect(hit!.segmentIndex).toBe(0); // 退回的是排名最前的那段
    expect(hit!.recallRank).toBe(0);
  });

  it('topK 之外的名次不参与对齐', async () => {
    // 只有段 2 含「末段」；topK=1 时只试段 0，必然退回整段
    const hit = await locateSemantic(DOC3, '关键词', rankByIndexDesc, {
      aligner: alignOnlyInMiddle,
      minRecallScore: 0.1,
      topK: 1,
    });
    expect(hit!.via).toBe('segment');
    expect(hit!.segmentIndex).toBe(0);
  });

  it('★ 第一名就能对齐时不浪费后续候选', async () => {
    // 让段 0 成为唯一含目标词的段
    const doc = '关键词在第一段。其它段落平平。';
    const hit = await locateSemantic(doc, '关键词', rankByIndexDesc, {
      aligner: alignOnlyInMiddle,
      minRecallScore: 0.1,
      topK: 3,
    });
    expect(hit!.via).toBe('aligned');
    expect(hit!.segmentIndex).toBe(0);
    expect(hit!.recallRank).toBe(0);
  });
});

/**
 * 对齐器契约。
 *
 * 调用方（如 `@isdk/excerpt-match`）需要把段内偏移换算回**整页**坐标，
 * 因此除了段落文本，还必须知道这一段在整页中的起始下标 —— 否则只能靠
 * `indexOf` 反查，重复段落时会查错。
 */
describe('★ 对齐器契约：必须收到段落在整页中的起始下标', () => {
  const DOC3 = '第一段内容平平。第二段含有关键词。第三段同样平平。';
  const anyRank: SemanticRetriever = (_e, segments) =>
    segments.map((_s, index) => ({ index, score: 0.9 - index * 0.1 }));

  it('★ 第三个参数就是该段在输入文本中的起始下标', async () => {
    const seen: number[] = [];
    await locateSemantic(DOC3, '关键词', anyRank, {
      minRecallScore: 0.1,
      aligner: (_excerpt, segText, segStart) => {
        seen.push(segStart);
        // 用 segStart 反查整页，必须能取回同一段文本
        expect(DOC3.slice(segStart, segStart + segText.length)).toBe(segText);
        return null;
      },
    });
    expect(seen.length).toBeGreaterThan(0);
    // 段 0 / 段 1 / 段 2 的起始下标
    expect(seen[0]).toBe(0);
    expect(seen).toContain(DOC3.indexOf('第二段'));
    expect(seen).toContain(DOC3.indexOf('第三段'));
  });

  it('★ 重复段落也能区分（indexOf 反查做不到）', async () => {
    // 两段文本完全相同 —— 靠内容定位必然查错，只能靠起始下标
    const dup = '同样的一句话。同样的一句话。';
    const starts: number[] = [];
    await locateSemantic(dup, '同样', anyRank, {
      minRecallScore: 0.1,
      aligner: (_e, _seg, segStart) => {
        starts.push(segStart);
        return null;
      },
    });
    expect(new Set(starts).size).toBe(starts.length); // 起始下标互不重复
    expect(starts).toContain(0);
    expect(starts).toContain(7);
  });
});

/** 检索器上下文：locale / tokenize 必须真的传下去，否则这个参数形同虚设 */
describe('★ 检索器上下文 ctx', () => {
  const DOC = '本院认为被告构成根本违约。应当承担赔偿责任。';

  it('★ locale 传给检索器', async () => {
    let seen: string | undefined;
    const spy: SemanticRetriever = (excerpt, segments, ctx) => {
      seen = ctx.locale;
      return segments.map((_s, index) => ({ index, score: 1 - index * 0.1 }));
    };
    await locateSemantic(DOC, '根本违约', spy, { minRecallScore: 0.1, locale: 'zh' });
    expect(seen).toBe('zh');
  });

  it('★ tokenize 传给检索器（BM25 需要它）', async () => {
    let tokens: string[] | undefined;
    const spy: SemanticRetriever = (excerpt, _segments, ctx) => {
      tokens = ctx.tokenize?.(excerpt);
      return [{ index: 0, score: 1 }];
    };
    await locateSemantic(DOC, '根本违约', spy, {
      minRecallScore: 0.1,
      tokenize: (t) => Array.from(t),
    });
    expect(tokens).toEqual(Array.from('根本违约'));
  });
});
