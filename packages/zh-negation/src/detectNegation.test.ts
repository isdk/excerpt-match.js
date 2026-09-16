import { describe, expect, it } from 'vitest';
import {
  detectNegation,
  negationsConflict,
  CHINESE_NEGATION_WORDS,
  CHINESE_NON_NEGATION_WORDS,
  CONFLICTING_WORDS,
} from './detectNegation';

describe('基本否定词', () => {
  it('单字否定词', () => {
    for (const s of ['他不去', '他没有来', '未能到场', '尚未完成']) {
      expect(detectNegation(s).negated, s).toBe(true);
    }
  });

  it('非否定句', () => {
    for (const s of ['他去了', '已经完成', '本院认为']) {
      expect(detectNegation(s).negated, s).toBe(false);
    }
  });
});

describe('★ 实词不被误判（本包存在的理由）', () => {
  it('含否定字但不是否定的常见词', () => {
    // 子串扫描会把这些全判成否定
    for (const s of ['非常高兴', '无锡', '未来世界', '非洲', '别人', '特别', '休息', '告别']) {
      expect(detectNegation(s).negated, s).toBe(false);
    }
  });

  it('但真正的否定词不被白名单误杀', () => {
    // 排除表按整个词匹配，不按前缀 —— 前缀会误杀这些
    // 注：「无论如何」里的「无论」= regardless，不是否定，故排除在外
    for (const s of ['无法完成', '未能到场', '尚未完成']) {
      expect(detectNegation(s).negated, s).toBe(true);
    }
  });
});

describe('★ 双重否定 = 肯定', () => {
  it('不得不 → 非否定（奇偶判定）', () => {
    expect(detectNegation('他不得不去').negated).toBe(false);
  });

  it('单个否定 → 否定', () => {
    expect(detectNegation('他不去').negated).toBe(true);
  });

  it('★ 不能只数出一个 —— 全局最长匹配会漏', () => {
    // 「不得不」若只匹配一次就跳过，会漏掉第二个「不」
    expect(detectNegation('不得不').marks.length).toBe(2);
  });
});

describe('英文（中文文档夹英文很常见）', () => {
  it('整词匹配', () => {
    for (const s of ['not good', 'never', 'without doubt']) {
      expect(detectNegation(s).negated, s).toBe(true);
    }
  });

  it('★ 缩写 n\'t 必须被识别', () => {
    // 早期版本对 n't 做词边界检查，而 don't 里 n't 前是字母，直接被跳过
    for (const s of ["don't", "doesn't", "can't", "won't", "isn't"]) {
      expect(detectNegation(s).negated, s).toBe(true);
    }
  });

  it('★ 不含否定的相似词不被误判', () => {
    // notice / noon 含 not/no 但整词不同
    for (const s of ['notice', 'noon', 'another']) {
      expect(detectNegation(s).negated, s).toBe(false);
    }
  });
});

describe('领域词表覆盖（多义词）', () => {
  it('默认保守：「未来」按时间名词', () => {
    for (const s of ['未来', '他未来', '他来自未来']) {
      expect(detectNegation(s).negated, s).toBe(false);
    }
  });

  it('★ negations 能解除内置白名单的保护', () => {
    // 若只 add 而不从白名单移除，覆盖会静默失效
    expect(detectNegation('他未来', { negations: ['未来'] }).negated).toBe(true);
  });

  it('nonNegations 优先级最高', () => {
    expect(detectNegation('没有', { nonNegations: ['没有'] }).negated).toBe(false);
    expect(detectNegation('未来', { negations: ['未来'], nonNegations: ['未来'] }).negated).toBe(false);
  });

  it('可保护产品名/术语', () => {
    expect(detectNegation('无限制套餐', { nonNegations: ['无限制'] }).negated).toBe(false);
  });
});

describe('negationsConflict', () => {
  it('极性不同 → 冲突', () => {
    const a = detectNegation('人工智能在改变世界');
    const b = detectNegation('人工智能没在改变世界');
    expect(negationsConflict(a, b)).toBe(true);
  });

  it('★ 只比奇偶不比用词', () => {
    // 「不去」与「没去」同为否定，不算冲突
    const a = detectNegation('他不去');
    const b = detectNegation('他没去');
    expect(negationsConflict(a, b)).toBe(false);
  });
});

describe('★ 词表冲突自检（回归）', () => {
  it('两表不应有交集 —— 否则否定词会静默失效', () => {
    // 非否定表优先级最高，冲突项会让它永远不生效。
    // 曾中招：尚未 / 未必 / 未曾 同时在两表，导致真否定句被判为肯定。
    expect([...CONFLICTING_WORDS]).toEqual([]);
  });

  it('★ 被误放进白名单的否定词现在生效', () => {
    for (const s of ['尚未完成', '未曾提及', '未必正确']) {
      expect(detectNegation(s).negated, s).toBe(true);
    }
  });
});

describe('词表常量', () => {
  it('「未来」在白名单里，故默认不否定', () => {
    expect(CHINESE_NON_NEGATION_WORDS.has('未来')).toBe(true);
    expect(CHINESE_NEGATION_WORDS.has('没有')).toBe(true);
  });
});
