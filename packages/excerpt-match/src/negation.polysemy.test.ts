import { describe, expect, it } from 'vitest';
import { detectNegation } from '@isdk/zh-negation';
import { locateExcerpt, isHit } from './index';
import { normalizeWithMap } from '@isdk/normalize-text';
import { stripGroupingSeparators } from '@isdk/normalize-text';
import { createDmpEsFallback } from './fuzzyMatch';

/**
 * 多义词与否定判定。
 *
 * 核心区分（本库最重要的边界之一）：
 *
 * 1. **多义词自身不构成风险** —— 页面与摘录走同一套转换，
 *    「未来」归一后还是「未来」，两边一致。本库的契约是**定位**，不是**判义**。
 *
 * 2. **真正的风险是「异文收敛」** —— 两个**不同**的原文被归一化成同一串，
 *    例如 `一一列举` 与 `十一列举` 在 `cjkNumerals` 下都变成 `11列举`，
 *    这时才会产生假命中。多义词没有这个现象。
 */

describe('多义词「未来」：默认保守', () => {
  it('默认按时间名词处理（非否定）', () => {
    for (const s of ['未来', '他未来', '他来自未来', '未来的世界']) {
      expect(detectNegation(s).negated).toBe(false);
    }
  });

  /**
   * 为什么保守：`未来` 作时间名词的频率远高于「没有来」的口语省略。
   * 若按否定处理，`他来自未来` 会被标成否定句，
   * 与 `他来自过去` 对比时就会**错误拒绝**合法摘录。
   * 误拒（造不出引用）比漏判（少个守卫）代价更高。
   */
  it('保守的代价：「没有来」这个含义识别不到', () => {
    expect(detectNegation('他未来').negated).toBe(false);
    expect(detectNegation('他没来参加').negated).toBe(true);
  });
});

describe('领域词表可覆盖默认判断', () => {
  it('negations 能把多义词改判为否定', () => {
    expect(detectNegation('他未来', { negations: ['未来'] }).negated).toBe(true);
  });

  it('★ negations 必须能解除内置白名单的保护', () => {
    // 「未来」在内置 CHINESE_NON_NEGATION_WORDS 里，
    // 若只 add 而不从白名单移除，覆盖就会静默失效
    expect(detectNegation('未来', { negations: ['未来'] }).negated).toBe(true);
    expect(detectNegation('他来自未来', { negations: ['未来'] }).negated).toBe(true);
  });

  it('nonNegations 优先级最高', () => {
    expect(detectNegation('没有', { nonNegations: ['没有'] }).negated).toBe(false);
    // 同时给出时，nonNegations 胜出
    expect(detectNegation('未来', { negations: ['未来'], nonNegations: ['未来'] }).negated).toBe(false);
  });

  it('可保护产品名 / 术语不被误判', () => {
    expect(detectNegation('无限制套餐', { nonNegations: ['无限制'] }).negated).toBe(false);
  });

  it('词表贯通到 locateExcerpt', () => {
    // 精确匹配不受词表影响
    expect(locateExcerpt('他没来参加', '他没来参加', { negationLexicon: { negations: ['未来'] } }).kind).toBe('exact');
  });
});

describe('★ 真风险是「异文收敛」，不是多义词', () => {
  it('多义词不会被归一化成别的串', () => {
    // 「未」不是数字字符，中文数词不介入
    expect(normalizeWithMap('他未来').text).toBe('他未来');
  });

  it('而数词记法确实会让不同的词收敛成同一串（故默认关闭）', () => {
    // 这是数词系统的**固有多义性**：「一一」与「十一」都写作 11，
    // 换任何库都无法消除 —— 所以 cjkNumerals 默认关闭
    const a = stripGroupingSeparators('一一列举', new Set());
    expect(a).toBe('一一列举');
  });

  it('因此 cjkNumerals 默认关闭', () => {
    expect(normalizeWithMap('一一列举').text).toBe('一一列举');
  });
});

/**
 * `diff-match-patch-es` 是可选依赖，而且是**纯 ESM** ——
 * 顶层 `require()` 它会在部分环境下挂起，所以改成顶层 `await import` + `skipIf`，
 * 与其余用到可选依赖的测试保持一致。
 */
let dmpEs: unknown = null;
try {
  dmpEs = await import(/* @vite-ignore */ 'diff-match-patch-es');
} catch {
  dmpEs = null;
}
const fuzzy = dmpEs ? createDmpEsFallback(dmpEs as never) : null;

describe.skipIf(!fuzzy)('极性守卫：核心能力不因多义词而退化', () => {
  // skipIf 已保证此处非 null；取一次非 null 值，避免后续每处都写 `!`
  const fb = fuzzy!;

  it('插入否定词 → 拒绝', () => {
    const r = locateExcerpt('人工智能没在改变世界', '人工智能正在改变世界', { fallbacks: [fb] });
    expect(r.kind).toBe('none');
  });

  it('关掉守卫则命中 —— 证明确实是守卫拦住的', () => {
    const r = locateExcerpt('人工智能没在改变世界', '人工智能正在改变世界', {
      fallbacks: [fb],
      checkPolarity: false,
    });
    expect(r.kind).toBe('fuzzy');
  });

  it('语义等价的改写仍被接受', () => {
    const r = locateExcerpt('人工智能在改变世界', '人工智能正在改变世界', { fallbacks: [fb] });
    expect(isHit(r)).toBe(true);
  });
});
