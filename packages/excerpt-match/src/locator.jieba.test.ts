import { describe, expect, it } from 'vitest';
import { locateExcerpt, isHit, createJiebaParticleTagger, normalizeWithMap } from './index';
import type { ParticleTagger } from '@isdk/zh-particles';

/**
 * 中文结构助词「的 / 地 / 得」：为什么需要词性。
 *
 * 无脑折叠会让「辽阔的大地」匹配上「辽阔的大的」且 score = 1.00 ——
 * 系统在宣称两段文本完全一致，而它们并不一致。
 */

// jieba 是可选依赖，装了才跑精确用例
let jieba: any = null;
try {
  jieba = require('@isdk/nlp-jieba');
} catch {
  jieba = null;
}

describe('内置保守模式（零依赖）', () => {
  const OPT = { ignoreParticles: true as const };

  it('默认关闭', () => {
    expect(locateExcerpt('他高兴的接受了', '他高兴地接受了').kind).toBe('none');
    expect(locateExcerpt('他高兴地接受了', '他高兴地接受了').kind).toBe('exact');
  });

  it('开启后助词混用命中，且不降级（score 保持 1）', () => {
    for (const ex of ['他高兴的接受了', '他高兴得接受了']) {
      const r = locateExcerpt(ex, '他高兴地接受了', OPT);
      expect(isHit(r)).toBe(true);
      expect(r.score).toBe(1);
    }
  });

  it('坐标仍是精确的源码片段', () => {
    const r = locateExcerpt('他高兴的接受了', '他高兴地接受了', OPT);
    expect('他高兴地接受了'.slice(r.index, r.index + r.length)).toBe('他高兴地接受了');
  });

  it('保护表内的实词不被折叠', () => {
    for (const [pv, ev] of [
      ['这片土地很肥沃', '这片土的很肥沃'],
      ['辽阔的大地', '辽阔的大的'],
      ['他得到了批准', '他到的了批准'],
    ]) {
      expect(locateExcerpt(ev, pv, OPT).kind).toBe('none');
    }
  });

  it('可注入自定义判定器', () => {
    const denyAll: ParticleTagger = { name: 'deny', foldableAt: () => new Set() };
    expect(locateExcerpt('他高兴的接受了', '他高兴地接受了', { ignoreParticles: denyAll }).kind).toBe('none');
  });

  it('归一化幂等', () => {
    for (const s of ['他高兴地笑了', '我的书', '跑得快', '辽阔的大地']) {
      const a = normalizeWithMap(s, OPT).text;
      expect(normalizeWithMap(a, OPT).text).toBe(a);
    }
  });
});

describe.skipIf(!jieba)('jieba 精确模式（可选依赖）', () => {
  const tagger = jieba ? createJiebaParticleTagger(jieba) : null;
  const OPT = { ignoreParticles: tagger! };

  it('jieba 能把助词与实词分开（这是它存在的理由）', () => {
    jieba.addDefaultDict();
    const t = (s: string) => jieba.tag(s, true).map((x: any) => `${x.word}/${x.tag}`).join(' ');
    expect(t('他高兴地接受了')).toContain('地/uv'); // 独立助词
    expect(t('这片土地')).toContain('土地/n'); // 名词，无独立助词
    expect(t('这片土地')).not.toContain('地/uv');
    expect(t('他得到了批准')).toContain('得到/v');
  });

  it('真实助词混用 → 命中且 score 为 1', () => {
    for (const [pv, ev] of [
      ['他高兴地接受了', '他高兴的接受了'],
      ['他高兴地接受了', '他高兴得接受了'],
      ['快速地奔跑', '快速的奔跑'],
      ['跑得非常快', '跑的非常快'],
    ] as Array<[string, string]>) {
      const r = locateExcerpt(ev, pv, OPT);
      expect(r.kind).not.toBe('none');
      expect(r.score).toBe(1);
    }
  });

  it('★ 实词不被误判（保守模式挡不住的，jieba 能挡住）', () => {
    for (const [pv, ev] of [
      ['辽阔的大地', '辽阔的大的'],
      ['这片土地很肥沃', '这片土的很肥沃'],
      ['他得到了批准', '他到的了批准'],
      ['这值得推广', '这值的推广'],
      ['详细地址如下', '详细的址如下'],
      ['他懂得道理', '他懂的道里'],
      ['觉得不错', '觉的不错'],
      ['获得成功', '获的成功'],
    ] as Array<[string, string]>) {
      expect(locateExcerpt(ev, pv, OPT).kind).toBe('none');
    }
  });

  it('foldableAt 返回字符偏移', () => {
    const set = tagger!.foldableAt('他高兴地接受了');
    expect([...set]).toEqual([3]); // 「地」在第 3 位
  });

  it('空文本与超长文本安全', () => {
    expect(tagger!.foldableAt('').size).toBe(0);
    const long = '本院认为'.repeat(100000);
    expect(tagger!.foldableAt(long).size).toBe(0); // 超过 maxLength，跳过
  });
});
