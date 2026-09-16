import { describe, it, expect } from 'vitest';
import {
  locateExcerpt,
  createTextIndex,
  isHit,
  NO_MATCH,
  detectLanguageProfile,
  DEFAULT_ELLIPSIS,
  createDmpEsFallback,
  createDmpFallback,
  tokenize,
  languageProfileFor,
} from './index';
import { diff_match_patch } from 'diff-match-patch';
import * as dmpEs from 'diff-match-patch-es';
import { createCjkNumberParser, normalizeWithMap, snapToGraphemeBoundary } from '@isdk/normalize-text';
import type { CjkNumberLike } from '@isdk/normalize-text';
import { detectNegation } from '@isdk/zh-negation';
import { createJiebaParticleTagger } from '@isdk/zh-particles';

// cjk-number 是可选依赖，且是 **ESM-only**（package.json 没有 CJS main，require 会失败）。
// 所以用动态 import 加载；未安装时静默跳过相关用例。
let CJK: CjkNumberLike | null = null;
try {
  CJK = (await import(/* @vite-ignore */ 'cjk-number')) as unknown as CjkNumberLike;
} catch {
  CJK = null;
}

const fuzzy = createDmpFallback(new diff_match_patch());
const fuzzyEs = createDmpEsFallback(dmpEs);

describe('统一返回契约', () => {
  it('未命中也返回对象', () => {
    const r = locateExcerpt('完全无关的一段话', '中华人民共和国民法典第一条');
    expect(r.kind).toBe('none');
    expect(r.index).toBe(-1);
    expect(r.length).toBe(0);
    expect(r.score).toBe(0);
    expect(isHit(r)).toBe(false);
    expect(r).toEqual({ ...NO_MATCH, occurrences: r.occurrences });
  });
});

describe('确定性层 T0/T1/T2', () => {
  it('T0 精确', () => {
    const page = '前缀人工智能正在改变世界后缀';
    const r = locateExcerpt('人工智能正在改变世界', page);
    expect(r.kind).toBe('exact');
    expect(page.slice(r.index, r.index + r.length)).toBe('人工智能正在改变世界');
  });

  it('T1 空白 / 全半角 / 标点 / 大小写 / 零宽', () => {
    const cases: Array<[string, string]> = [
      ['Hello   world\nthis  is\u00A0fine', 'hello world this is fine'],
      ['他说：“今天（2026年）会下雨”。', '他说:"今天(2026年)会下雨".'],
      ['中华人民共和国民法典', '中华\u200B人民\u00AD共和国民法典'],
      ['你好\n世界', '你好 世界'],
      ['ＡＢＣ　１２３', 'abc 123'],
    ];
    for (const [page, ex] of cases) {
      const r = locateExcerpt(ex, page);
      expect(r.kind).toBe('normalized');
      expect(r.score).toBe(1);
    }
  });

  it('T1 不越界：默认不忽略标点', () => {
    expect(locateExcerpt('这件事不，是这样的', '这件事不是这样的').kind).toBe('none');
  });

  it('T2 省略号分段锚点', () => {
    const page =
      '第一条 为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，适应中国特色社会主义发展要求，弘扬社会主义核心价值观，根据宪法，制定本法。';
    const r = locateExcerpt('为了保护民事主体的合法权益……根据宪法，制定本法。', page);
    expect(r.kind).toBe('segmented');
    const s = page.slice(r.index, r.index + r.length);
    expect(s.startsWith('为了保护')).toBe(true);
    expect(s.endsWith('制定本法。')).toBe(true);
  });

  it('T2 拒绝过短碎片', () => {
    const page = '甲说了一句话，乙说了另一句话，丙又说了第三句话';
    expect(locateExcerpt('甲……丙', page).kind).toBe('none');
  });
});

describe('坐标不变量', () => {
  it('300 次随机切片：必命中且坐标还原', () => {
    const page =
      '最高人民法院关于适用《中华人民共和国民法典》合同编通则若干问题的解释（法释〔2023〕13号），自 2023 年 12 月 5 日起施行。\n\n' +
      '其中第 5 条规定：当事人一方不履行合同义务或者履行合同义务不符合约定的，应当承担继续履行、采取补救措施或者赔偿损失等违约责任。  \n' +
      'The court held that the contract was valid and enforceable.';
    let checked = 0;
    for (let k = 0; k < 300; k++) {
      const i = Math.floor(Math.random() * page.length);
      const j = Math.min(page.length, i + 6 + Math.floor(Math.random() * 40));
      const ex = page.slice(i, j);
      if (ex.trim().length < 4) continue;
      if (page.indexOf(ex) !== i) continue;
      const r = locateExcerpt(ex, page);
      expect(isHit(r)).toBe(true);
      expect(r.index).toBe(i);
      expect(r.length).toBe(ex.length);
      expect(page.slice(r.index, r.index + r.length)).toBe(ex);
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('T3：diff-match-patch', () => {
  it('中文漏字', () => {
    const page = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const r = locateExcerpt('本院认为，被告的行为构成违约', page, { fallbacks: [fuzzy] });
    expect(r.kind).toBe('fuzzy');
    expect(r.via).toBe('diff-match-patch');
    expect(r.score).toBeGreaterThan(0.7);
  });

  it('英文错字', () => {
    const page = 'The quick brown fox jumps over the lazy dog.';
    const r = locateExcerpt('The quick brown fox jump over the lazy dog', page, { fallbacks: [fuzzy] });
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('偏差过大 → none', () => {
    const page = '重庆市渝中区人民法院受理了该案，并于同日立案。';
    expect(locateExcerpt('北京市朝阳区人民检察院提起公诉', page, { fallbacks: [fuzzy] }).kind).toBe('none');
  });

  it('无 fallback 时不做模糊（严格模式）', () => {
    expect(
      locateExcerpt('本院认为，被告的行为构成违约', '本院认为，被告的行为已经构成根本违约，应当承担违约责任。').kind
    ).toBe('none');
  });
});


describe('自定义省略号（T2）', () => {
  const page =
    '第一条 为了保护民事主体的合法权益，调整民事关系，维护社会和经济秩序，' +
    '适应中国特色社会主义发展要求，弘扬社会主义核心价值观，根据宪法，制定本法。';

  it('默认模式：... 与 …… 与 〔略〕', () => {
    for (const ex of [
      '为了保护民事主体的合法权益……根据宪法，制定本法。',
      '为了保护民事主体的合法权益...根据宪法，制定本法。',
      '为了保护民事主体的合法权益。。。根据宪法，制定本法。',
    ]) {
      const r = locateExcerpt(ex, page);
      expect(r.kind).toBe('segmented');
      expect(page.slice(r.index, r.index + r.length).startsWith('为了保护')).toBe(true);
    }
  });

  it('自定义：完全替换默认模式', () => {
    const ex = '为了保护民事主体的合法权益〔中略〕根据宪法，制定本法。';
    // 默认模式不认 〔中略〕
    expect(locateExcerpt(ex, page).kind).toBe('none');
    // 传入自定义模式后命中
    const r = locateExcerpt(ex, page, { ellipsis: ['〔中略〕'] });
    expect(r.kind).toBe('segmented');
    expect(page.slice(r.index, r.index + r.length)).toContain('根据宪法，制定本法。');
  });

  it('自定义：支持多个模式 + 正则', () => {
    const cases: Array<[string, string]> = [
      ['为了保护民事主体的合法权益〔中略〕根据宪法，制定本法。', '〔中略〕'],
      ['为了保护民事主体的合法权益[snip]根据宪法，制定本法。', '[snip]'],
      ['为了保护民事主体的合法权益<<<>>>根据宪法，制定本法。', '<<<>>>'],
    ];
    const r0 = locateExcerpt(cases[0][0], page, { ellipsis: ['〔中略〕', '[snip]', '<<<>>>'] });
    expect(r0.kind).toBe('segmented');
    for (const [ex] of cases) {
      expect(locateExcerpt(ex, page, { ellipsis: ['〔中略〕', '[snip]', '<<<>>>'] }).kind).toBe('segmented');
    }
  });

  it('字符串按字面量匹配，不被当成正则', () => {
    // '...' 若被当正则会匹配任意三字符，导致处处可切
    const r = locateExcerpt('为了保护民事主体的合法权益...根据宪法，制定本法。', page, { ellipsis: ['...'] });
    expect(r.kind).toBe('segmented');
    // 三个任意字符不应被当作省略号
    expect(locateExcerpt('为了保护民事主体的合法权益abc根据宪法，制定本法。', page, { ellipsis: ['...'] }).kind).toBe('none');
  });

  it('正则模式按原样使用', () => {
    const r = locateExcerpt(
      '为了保护民事主体的合法权益---根据宪法，制定本法。',
      page,
      { ellipsis: [/\s*-{2,}\s*/] }
    );
    expect(r.kind).toBe('segmented');
  });

  it('可 concat 默认模式（保留 + 追加）', () => {
    const ex = '为了保护民事主体的合法权益〔中略〕根据宪法，制定本法。';
    const r = locateExcerpt(ex, page, { ellipsis: [...DEFAULT_ELLIPSIS, '〔中略〕'] });
    expect(r.kind).toBe('segmented');
    // 默认模式仍然生效
    expect(locateExcerpt('为了保护民事主体的合法权益……根据宪法，制定本法。', page, {
      ellipsis: [...DEFAULT_ELLIPSIS, '〔中略〕'],
    }).kind).toBe('segmented');
  });

  it('归一化陷阱：全角括号会被折叠，模式仍能匹配', () => {
    // 切分发生在归一化之后，NFKC 把 〔中略〕 折成 [中略]。
    // 字符串模式必须先过同样的归一化，否则永远匹配不上。
    const ex = '为了保护民事主体的合法权益〔中略〕根据宪法，制定本法。';
    expect(locateExcerpt(ex, page, { ellipsis: ['〔中略〕'] }).kind).toBe('segmented');
    // 直接写归一化后的半角形式同样可用
    expect(locateExcerpt(ex, page, { ellipsis: ['[中略]'] }).kind).toBe('segmented');
  });

  it('空数组 = 关闭 T2（不是「处处可切」）', () => {
    const ex = '为了保护民事主体的合法权益……根据宪法，制定本法。';
    expect(locateExcerpt(ex, page).kind).toBe('segmented');
    expect(locateExcerpt(ex, page, { ellipsis: [] }).kind).toBe('none');
  });

  it('重复调用结果稳定（lastIndex 不残留）', () => {
    const ex = '为了保护民事主体的合法权益……根据宪法，制定本法。';
    for (let i = 0; i < 5; i++) {
      expect(locateExcerpt(ex, page).kind).toBe('segmented');
    }
  });
});

describe('T3 后端：diff-match-patch-es', () => {
  it('中文漏字能命中，分数与原版接近', () => {
    const page = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    const ex = '本院认为，被告的行为构成违约';
    const a = locateExcerpt(ex, page, { fallbacks: [fuzzy] });
    const b = locateExcerpt(ex, page, { fallbacks: [fuzzyEs] });
    expect(b.kind).toBe('fuzzy');
    expect(b.via).toBe('diff-match-patch-es');
    expect(b.score).toBeGreaterThan(0.7);
    expect(Math.abs(a.score - b.score)).toBeLessThan(0.35);
  });

  it('英文错字', () => {
    const page = 'The quick brown fox jumps over the lazy dog.';
    const r = locateExcerpt('The quick brown fox jump over the lazy dog', page, { fallbacks: [fuzzyEs] });
    expect(r.score).toBeGreaterThan(0.85);
  });

  it('无 fallback 时不做模糊', () => {
    const page = '本院认为，被告的行为已经构成根本违约，应当承担违约责任。';
    expect(locateExcerpt('本院认为，被告的行为构成违约', page).kind).toBe('none');
  });
});


describe('语义等价 vs 语义相反（极性守卫）', () => {
  const page = '前缀人工智能正在改变世界后缀';

  it('相似度区分不了「少虚词」和「多否定词」—— 这是守卫存在的理由', () => {
    const off = { fallbacks: [fuzzyEs], minFallbackScore: 0, checkPolarity: false };
    const a = locateExcerpt('人工智能在改变世界', page, off);   // 等价
    const b = locateExcerpt('人工智能没在改变世界', page, off); // 相反
    expect(a.kind).toBe('fuzzy');
    expect(b.kind).toBe('fuzzy');
    // 两者分数只差 0.05 左右，调阈值无解
    expect(Math.abs(a.score - b.score)).toBeLessThan(0.1);
  });

  it('语义等价（少「正」）→ 接受', () => {
    const r = locateExcerpt('人工智能在改变世界', page, { fallbacks: [fuzzyEs] });
    expect(r.kind).toBe('fuzzy');
    expect(r.score).toBeGreaterThan(0.9);
  });

  it('语义相反（多「没」）→ 拒绝', () => {
    expect(locateExcerpt('人工智能没在改变世界', page, { fallbacks: [fuzzyEs] }).kind).toBe('none');
  });

  it('否定词在命中 span 之外不干扰', () => {
    const p = '本院不支持该主张。人工智能正在改变世界，这是不争的事实。';
    expect(isHit(locateExcerpt('人工智能在改变世界', p, { fallbacks: [fuzzyEs] }))).toBe(true);
    expect(locateExcerpt('人工智能没在改变世界', p, { fallbacks: [fuzzyEs] }).kind).toBe('none');
  });

  it('原文是否定句：否定型摘录命中，肯定型被拒', () => {
    const p = '法院认定被告并未构成根本违约';
    // 原样
    expect(locateExcerpt('被告并未构成根本违约', p).kind).toBe('exact');
    // 同义否定词替换（都是否定，极性一致）
    for (const ex of ['被告没有构成根本违约', '被告不构成根本违约']) {
      expect(isHit(locateExcerpt(ex, p, { fallbacks: [fuzzyEs] }))).toBe(true);
    }
    // 肯定型：极性相反 → 拒绝
    expect(locateExcerpt('被告构成根本违约', p, { fallbacks: [fuzzyEs] }).kind).toBe('none');
  });

  it('双重否定算肯定', () => {
    const p = '他不得不接受这个结果';
    expect(locateExcerpt('他不得不接受', p).kind).toBe('exact');
    // 「不得不」= 两个否定 = 肯定，与肯定型摘录极性一致
    expect(isHit(locateExcerpt('他接受了这个结果', p, { fallbacks: [fuzzyEs] }))).toBe(true);
  });

  it('英文否定', () => {
    const p = 'The contract is valid and enforceable under the law.';
    expect(locateExcerpt('The contract is valid and enforceable', p).kind).toBe('exact');
    expect(locateExcerpt('The contract is not valid', p, { fallbacks: [fuzzyEs] }).kind).toBe('none');
  });

  it('checkPolarity: false 可关闭守卫（退回纯相似度）', () => {
    const r = locateExcerpt('人工智能没在改变世界', page, {
      fallbacks: [fuzzyEs],
      minFallbackScore: 0,
      checkPolarity: false,
    });
    expect(r.kind).toBe('fuzzy');
  });

  it('T0–T2 不受守卫影响（字面匹配极性天然一致）', () => {
    // 原文真是否定句，摘录也带否定词 → 精确命中
    expect(locateExcerpt('被告并未构成根本违约', '法院认定被告并未构成根本违约').kind).toBe('exact');
  });
});

describe('中文结构助词 的 / 地 / 得', () => {
  const page = '他高兴地接受了这份合同';

  it('默认不折叠：最安全', () => {
    // 默认 false —— 误判代价高于漏判
    expect(locateExcerpt('他高兴的接受了这份合同', page).kind).toBe('none');
    expect(locateExcerpt('他高兴得接受了这份合同', page).kind).toBe('none');
    expect(locateExcerpt('他高兴地接受了这份合同', page).kind).toBe('exact');
  });

  it('ignoreParticles: true → 保守模式，助词混用命中', () => {
    for (const ex of ['他高兴的接受了这份合同', '他高兴得接受了这份合同']) {
      const r = locateExcerpt(ex, page, { ignoreParticles: true });
      expect(isHit(r)).toBe(true);
      expect(r.score).toBe(1); // 确定性层，不降级
    }
  });

  it('坐标仍然精确：span 是原始源码片段', () => {
    const r = locateExcerpt('他高兴的接受了这份合同', page, { ignoreParticles: true });
    expect(page.slice(r.index, r.index + r.length)).toBe('他高兴地接受了这份合同');
  });

  it('保守模式挡住已知实词', () => {
    // 保护表内的词不应被折叠
    for (const [pv, ev] of [
      ['这片土地很肥沃', '这片土的很肥沃'],
      ['辽阔的大地', '辽阔的大的'],
      ['他得到了批准', '他到的了批准'],
    ]) {
      expect(locateExcerpt(ev, pv, { ignoreParticles: true }).kind).toBe('none');
    }
  });
});

describe('的/地/得：词性感知（jieba）', () => {
  const jieba = require('@isdk/nlp-jieba');
  const tagger = createJiebaParticleTagger(jieba);

  it('jieba 能把助词与实词分开（这是它存在的理由）', () => {
    jieba.addDefaultDict();
    const t = (s: string) => jieba.tag(s, true).map((x: any) => `${x.word}/${x.tag}`).join(' ');
    // 地 是独立助词 uj/uv
    expect(t('他高兴地接受了')).toContain('地/uv');
    // 土地 是名词，无独立助词
    expect(t('这片土地')).toContain('土地/n');
    expect(t('这片土地')).not.toContain('地/uv');
    // 得到 是动词
    expect(t('他得到了批准')).toContain('得到/v');
  });

  it('真实助词混用 → 命中', () => {
    const cases: Array<[string, string]> = [
      ['他高兴地接受了', '他高兴的接受了'],
      ['他高兴地接受了', '他高兴得接受了'],
      ['快速地奔跑', '快速的奔跑'],
      ['跑得非常快', '跑的非常快'],
    ];
    for (const [pv, ev] of cases) {
      const r = locateExcerpt(ev, pv, { ignoreParticles: tagger });
      expect(r.kind).not.toBe('none');
      expect(r.score).toBe(1);
    }
  });

  it('实词不被误判（保守模式挡不住的，jieba 能挡住）', () => {
    const cases: Array<[string, string]> = [
      ['辽阔的大地', '辽阔的大的'],
      ['这片土地很肥沃', '这片土的很肥沃'],
      ['他得到了批准', '他到的了批准'],
      ['这值得推广', '这值的推广'],
      ['详细地址如下', '详细的址如下'],
      ['他懂得道理', '他懂的道里'],
      ['觉得不错', '觉的不错'],
      ['获得成功', '获的成功'],
    ];
    for (const [pv, ev] of cases) {
      expect(locateExcerpt(ev, pv, { ignoreParticles: tagger, fallbacks: [fuzzyEs], minFallbackScore: 0.95 }).kind).toBe('none');
    }
  });

  it('jieba 模式不会让 score 说谎', () => {
    // 折叠命中时 score 仍是 1（确定性），但只发生在词性一致时
    const r = locateExcerpt('他高兴的接受了', '他高兴地接受了', { ignoreParticles: tagger });
    expect(r.score).toBe(1);
    // 而实词误用根本不命中，不存在 score=1 的假阳性
    expect(locateExcerpt('辽阔的大的', '辽阔的大地', { ignoreParticles: tagger }).kind).toBe('none');
  });

  it('foldableAt 给出的是字符偏移', () => {
    const set = tagger.foldableAt('他高兴地接受了');
    expect([...set]).toEqual([3]); // 「地」在第 3 位
  });
});


describe('混合文字的空格：能删才删', () => {
  /**
   * 判据：**删除空格是否造成边界歧义。**
   * 用「删空格前后分词结果是否一致」来客观判定，而不是凭语言直觉。
   */
  const seg = (loc: string, t: string) =>
    [...new Intl.Segmenter(loc, { granularity: 'word' }).segment(t)]
      .filter((x: any) => x.isWordLike)
      .map((x: any) => x.segment)
      .join('|');

  it('客观依据：汉字与假名删空格后分词一致，韩文与拉丁不一致', () => {
    // 汉字：一致 → 空格不载义
    expect(seg('zh', '本院认为被告违约')).toBe(seg('zh', '本院认为被告违约'));
    // 韩文：不一致 → 空格载义
    expect(seg('ko', '아버지가 방에 들어가신다')).not.toBe(seg('ko', '아버지가방에들어가신다'));
    // 拉丁：不一致 → 空格载义
    expect(seg('en', 'The court held')).not.toBe(seg('en', 'Thecourtheld'));
  });

  it('汉字 / 假名之间的空格：可删', () => {
    expect(isHit(locateExcerpt('本院 认为 被告 违约', '本院认为被告违约'))).toBe(true);
    expect(isHit(locateExcerpt('機械学習 の 応用', '機械学習の応用'))).toBe(true);
  });

  it('跨文字边界的空格：可删（排版产物）', () => {
    const cases: Array<[string, string]> = [
      ['使用 TensorFlow 框架', '使用TensorFlow框架'],
      ['共 100 人参加', '共100人参加'],
      ['第 3 条第 2 款', '第3条第2款'],
      ['สัญญา TensorFlow', 'สัญญาTensorFlow'],
    ];
    for (const [pv, ev] of cases) expect(isHit(locateExcerpt(ev, pv))).toBe(true);
  });

  it('拉丁词间空格：必须保留', () => {
    expect(locateExcerpt('Thecourt held', 'The court held').kind).toBe('none');
    // 英文词被拆开也拒绝
    expect(locateExcerpt('使用 Tensor Flow 框架', '使用 TensorFlow 框架').kind).toBe('none');
  });

  it('韩文：空格改变助词归属，必须保留', () => {
    // 「父亲走进房间」与「钻进父亲的包里」删空格后是同一串，绝不能互相匹配
    const a = '아버지가 방에 들어가신다';
    const b = '아버지 가방에 들어가신다';
    expect(locateExcerpt(b, a).kind).toBe('none');
    expect(locateExcerpt(a, b).kind).toBe('none');
    // 整段增删空格同样拒绝
    expect(locateExcerpt('한국법원은계약을인정했다', '한국 법원은 계약을 인정했다').kind).toBe('none');
  });

  it('泰文：空格是句子/短语边界，同样保留', () => {
    // 泰文词连写，空格分句子 —— 删掉即丢失句子边界，等价于英文删句号
    const a = 'ผู้ซื้อต้องชำระเงิน ผู้ขายต้องส่งมอบ';
    const b = 'ผู้ซื้อต้องชำระเงินผู้ขายต้องส่งมอบ';
    expect(locateExcerpt(b, a).kind).toBe('none');
  });

  it('数字间空格：保留（1 000 ≠ 1000）', () => {
    expect(locateExcerpt('共 1 000 人', '共 1000 人').kind).toBe('none');
  });
});


describe('数字记法归一（顺序敏感）', () => {
  /**
   * 核心：**数字归一必须排在 NFKC 之后、标点折叠之前**。
   * - 在 NFKC 之后 → 全角 `1，000` 已变成 `1,000`，能识别（中文文档主流写法）
   * - 在标点折叠之前 → 顿号 `1、000` 还没被折成 `,`，不会被误当千分位
   */
  it('半角千分位', () => {
    expect(isHit(locateExcerpt('共1,000人参加', '共1000人参加'))).toBe(true);
    expect(isHit(locateExcerpt('共1000人参加', '共1,000人参加'))).toBe(true);
  });

  it('★ 全角千分位（依赖 NFKC 先行）', () => {
    expect(isHit(locateExcerpt('共1，000人参加', '共1000人参加'))).toBe(true);
    expect(isHit(locateExcerpt('共1000人参加', '共1，000人参加'))).toBe(true);
  });

  it('★ 顿号不是千分位（依赖标点折叠在后）', () => {
    // 顿号是列表分隔符，删掉会改变意义
    expect(locateExcerpt('共1、000人参加', '共1000人参加').kind).toBe('none');
    // 顿号列表本身照常命中
    expect(isHit(locateExcerpt('共1、2、3项', '共1、2、3项'))).toBe(true);
  });

  it('严格模式：位数不对的不当千分位', () => {
    expect(locateExcerpt('共1,0000人', '共10000人').kind).toBe('none');
    expect(locateExcerpt('共12,34元', '共1234元').kind).toBe('none');
    expect(locateExcerpt('第1,2条', '第12条').kind).toBe('none');
  });

  it('下划线默认关闭，可显式开启', () => {
    expect(locateExcerpt('共1_000人参加', '共1000人参加').kind).toBe('none');
    expect(isHit(locateExcerpt('共1_000人参加', '共1000人参加', { groupingUnderscore: true }))).toBe(true);
  });

  it('中文数词默认关闭；开启需要注入解析后端', () => {
    // 换了一套数词系统，且「一一」/「十一」这类多义无法消除 → 默认不转
    expect(locateExcerpt('共一千人参加', '共1000人参加').kind).toBe('none');
    // 开了 cjkNumerals 但没注入后端 → 静默跳过，不崩
    expect(locateExcerpt('共一千人参加', '共1000人参加', { cjkNumerals: true }).kind).toBe('none');
  });

  it.skipIf(!CJK)('★ 注入 cjk-number 后端后，中文数词可跨写法命中', () => {
    const parser = createCjkNumberParser(CJK!);
    const opt = { cjkNumerals: true as const, cjkNumeralParser: parser };
    // 自研实现搞不定的：口语「两」、年份、大写
    for (const [pv, ev] of [
      ['共1000人参加', '共一千人参加'],
      ['共20000人参加', '共两万人参加'],
      ['2023年度报告', '二〇二三年度报告'],
      ['共1000人参加', '共壹仟人参加'],
    ] as Array<[string, string]>) {
      const r = locateExcerpt(ev, pv, opt);
      expect(isHit(r), `${ev} ← ${pv}`).toBe(true);
      // 坐标仍覆盖整个中文数词（长度自洽）
      expect(pv.slice(r.index, r.index + r.length)).toBe(pv);
    }
  });

  it('数字间空格保留（1 000 ≠ 1000）', () => {
    expect(locateExcerpt('共 1 000 人', '共 1000 人').kind).toBe('none');
  });

  it('幂等：归一后再归一不变', () => {
    const opt = CJK ? { cjkNumerals: true as const, cjkNumeralParser: createCjkNumberParser(CJK) } : {};
    for (const s of ['共1,000人', '共1，000人', '共一千人', '第1,000条']) {
      const a = normalizeWithMap(s, opt).text;
      const b = normalizeWithMap(a, opt).text;
      expect(b).toBe(a);
    }
  });
});


describe('标识符拼写归一：只拆不合', () => {
  const ID_OPT = { splitCamelCase: true, normalizeIdentifierSeparators: true };

  it('方向是「拆分」而非「合并」—— 这是刻意的选择', () => {
    // 自然文本里不会出现两个词紧贴无空格，所以「无空格 + 驼峰」是标识符的强信号；
    // 反过来据「有空格 + 驼峰」删空格，会误伤 Hello World 这类普通词组。
    expect(isHit(locateExcerpt('使用Tensor Flow框架', '使用TensorFlow框架', ID_OPT))).toBe(true);
    expect(isHit(locateExcerpt('使用TensorFlow框架', '使用Tensor Flow框架', ID_OPT))).toBe(true);
  });

  it('四种写法互通', () => {
    const forms = ['HelloWorld', 'hello world', 'hello_world', 'hello-world', 'helloWorld'];
    for (const a of forms) {
      for (const b of forms) {
        expect(isHit(locateExcerpt(b, a, ID_OPT))).toBe(true);
      }
    }
  });

  it('★ 普通英文词不会被粘连', () => {
    // thecourt 是小写接小写，没有驼峰，触发不了拆分；反过来也不会被合并
    expect(locateExcerpt('thecourt held', 'the court held', ID_OPT).kind).toBe('none');
  });

  it('★ 只在标识符语境生效：中文地名不被合并', () => {
    // `-` 两侧是汉字，不是 [A-Za-z0-9] → 不拆，避免「北京上海」这种合并
    expect(locateExcerpt('北京上海', '北京-上海', ID_OPT).kind).toBe('none');
    // 数字范围同理
    expect(locateExcerpt('第35条', '第3-5条', ID_OPT).kind).toBe('none');
  });

  it('千分位不受影响', () => {
    expect(isHit(locateExcerpt('共1000人', '共1,000人', ID_OPT))).toBe(true);
  });

  it('默认关闭', () => {
    expect(locateExcerpt('使用Tensor Flow框架', '使用TensorFlow框架').kind).toBe('none');
    expect(locateExcerpt('hello world', 'hello_world').kind).toBe('none');
  });

  it('已知限制：McDonald / iPhone 会误拆（但两边一致，不产生假阳性）', () => {
    // 页面与摘录走同一套转换，所以「同一个词」仍然匹配
    expect(isHit(locateExcerpt('McDonald', 'McDonald', ID_OPT))).toBe(true);
    expect(isHit(locateExcerpt('iPhone', 'iPhone', ID_OPT))).toBe(true);
  });
});


describe('辅助平面字符：字形簇边界', () => {
  /**
   * 用 `Intl.Segmenter({ granularity: 'grapheme' })`，不自己实现 ——
   * ZWJ 序列、国旗、肤色修饰符的规则随 Unicode 版本演进，手写必然补不全。
   */
  it('ZWJ 家庭 / 国旗 / 肤色修饰符不被切碎', () => {
    for (const cluster of ['👨‍👩‍👧‍👦', '🇨🇳', '👍🏽', 'a\u0301']) {
      const snapped = snapToGraphemeBoundary(cluster, 1, 1);
      expect(cluster.slice(snapped.index, snapped.index + snapped.length)).toBe(cluster);
    }
  });

  it('切在 ZWJ 序列中间时向外扩展到整个簇', () => {
    const text = '前缀👨‍👩‍👧‍👦后缀';
    const snapped = snapToGraphemeBoundary(text, 3, 1);
    expect(text.slice(snapped.index, snapped.index + snapped.length)).toBe('👨‍👩‍👧‍👦');
  });

  it('辅助平面字符上的定位仍然精确', () => {
    const page = '前缀👨‍👩‍👧‍👦后缀';
    const r = locateExcerpt('👨‍👩‍👧‍👦', page);
    expect(isHit(r)).toBe(true);
    expect(page.slice(r.index, r.index + r.length)).toBe('👨‍👩‍👧‍👦');
  });
});

describe('否定检测：必须在词边界上', () => {
  it('英文缩写否定', () => {
    for (const w of ["don't", "doesn't", "can't", "won't", "isn't", 'not', 'cannot']) {
      expect(detectNegation(w).negated).toBe(true);
    }
  });

  it('英文词内不误判（notice / noon）', () => {
    for (const w of ['notice', 'noon', 'someone is here']) {
      expect(detectNegation(w).negated).toBe(false);
    }
  });

  it('★ 中文实词不再被误判为否定', () => {
    // 朴素子串扫描会把「非常」里的「非」、「无锡」里的「无」当成否定词
    for (const w of ['非常', '别人', '非法', '无锡', '未来', '无意', '无关']) {
      expect(detectNegation(w).negated).toBe(false);
    }
  });

  it('中文否定仍正常识别', () => {
    for (const w of ['没有', '不去', '不能', '不应该', '无法', '他不去']) {
      expect(detectNegation(w).negated).toBe(true);
    }
  });

  it('双重否定仍算肯定', () => {
    expect(detectNegation('他不得不去').negated).toBe(false);
  });
});

describe('语言探测：按占比而非「见到一个就算」', () => {
  it('★ 汉字为主 + 个别假名/韩文，仍是中文', () => {
    // 朴素实现会因为有假名/韩文就把整篇判成 ja / ko
    expect(detectLanguageProfile('本院认为被告构成根本违约，契約').id).toBe('cjk');
    expect(detectLanguageProfile('本院认为被告构成根本违约，한국').id).toBe('cjk');
  });

  it('各语言为主时正确判定', () => {
    expect(detectLanguageProfile('契約違反による損害賠償請求').id).toBe('ja');
    expect(detectLanguageProfile('한국 법원은 계약을 인정했다').id).toBe('ko');
    expect(detectLanguageProfile('สัญญาผิดเงื่อนไขตามกฎหมาย').id).toBe('th');
    expect(detectLanguageProfile('The court held the contract valid').id).toBe('default');
  });
});

describe('语言层', () => {
  it('detectLanguageProfile 区分中/日/英', () => {
    expect(detectLanguageProfile('本院认为被告构成根本违约').id).toBe('cjk');
    expect(detectLanguageProfile('契約違反による損害賠償請求').id).toBe('ja');
    expect(detectLanguageProfile('The court held the contract valid').id).toBe('default');
  });

  it('tokenize：中文按字、英文按词、日文按 ICU 词', () => {
    expect(tokenize('本院认为', languageProfileFor('zh'))).toEqual(['本', '院', '认', '为']);
    expect(tokenize('the court held', languageProfileFor('en'))).toEqual(['the', 'court', 'held']);
    const ja = tokenize('契約違反による損害賠償', languageProfileFor('ja'));
    expect(ja).toContain('契約');
    expect(ja).toContain('損害賠償');
  });
});

describe('工程：缓存与歧义', () => {
  it('createTextIndex 复用归一化', () => {
    const unit = '本院经审理查明，二〇二三年五月十日，原告与被告签订《房屋买卖合同》，约定房屋总价款为人民币三百万元。';
    const page = unit.repeat(6000);
    const ex = '原告与被告签订<房屋买卖合同>';
    const t0 = Date.now();
    locateExcerpt(ex, page);
    const once = Date.now() - t0;
    const idx = createTextIndex(page);
    const t1 = Date.now();
    for (let i = 0; i < 20; i++) idx.locate(ex);
    const cached = (Date.now() - t1) / 20;
    expect(cached).toBeLessThan(Math.max(1, once / 3));
  });

  it('短摘录报 occurrences 提示歧义', () => {
    const page = '中国市场很大，中国市场也很复杂，中国市场需要长期主义。';
    expect(locateExcerpt('中国市场', page).occurrences).toBeGreaterThanOrEqual(3);
  });
});
