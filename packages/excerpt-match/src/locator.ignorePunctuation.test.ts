import { describe, expect, it } from 'vitest';
import { locateExcerpt, isHit } from './index';

/**
 * `ignorePunctuation` 与 T2 分段锚点的关系 —— 这是把开关做成复合写法的起因。
 *
 * 省略号本身是标点：`ignorePunctuation: true` 曾把它连同普通标点一起折掉，
 * 于是 T2 找不到切分点，「开了忽略标点」反而丢掉了分段锚点能力。
 */
describe('忽略标点时，摘录里的省略表达默认受保护', () => {
  const doc = '本院认为，被告构成根本违约。\n\n综上，被告应承担全部责任。';

  it('★ 开了 ignorePunctuation，摘录带「……」仍能走分段锚点', () => {
    const r = locateExcerpt('本院认为……被告应承担全部责任。', doc, { ignorePunctuation: true });
    expect(isHit(r)).toBe(true);
    expect(r.kind).toBe('segmented');
  });

  it('对照：显式允许折叠省略表达 → 退化到普通 T1（不再是分段锚点）', () => {
    const r = locateExcerpt('本院认为……被告应承担全部责任。', doc, {
      ignorePunctuation: { preserveEllipsis: false },
    });
    expect(r.kind).not.toBe('segmented');
  });

  it('自定义省略表达同样受保护 —— keep 与 ellipsis 共用一套模式', () => {
    const r = locateExcerpt('本院认为〔略〕被告应承担全部责任。', doc, {
      ellipsis: ['〔略〕'],
      ignorePunctuation: true,
    });
    expect(isHit(r)).toBe(true);
    expect(r.kind).toBe('segmented');
  });
});

describe("drop 档：折叠后不留占位符 —— 查重场景的「文字骨架」", () => {
  it('fold 下够不到（拉丁词边界占位符还在），drop 下命中', () => {
    const doc = 'ab, cd';
    expect(isHit(locateExcerpt('abcd', doc, { ignorePunctuation: true }))).toBe(false);
    expect(isHit(locateExcerpt('abcd', doc, { ignorePunctuation: 'drop' }))).toBe(true);
  });

  it('drop 不会让「有没有标点」变得不可判定 —— punctFolded 仍然可用', () => {
    const r = locateExcerpt('本院认为被告构成根本违约', '本院认为，被告构成根本违约。', {
      ignorePunctuation: 'drop',
    });
    expect(isHit(r)).toBe(true);
    expect(r.punctFolded).toBe(true); // 靠忽略标点才命中 → 送人工复核
  });
});

describe('symbols 开关：默认不动符号，开了才折', () => {
  const doc = 'value`key';

  it('默认：反引号是普通字符，缺了它就够不到', () => {
    expect(isHit(locateExcerpt('value key', doc, { ignorePunctuation: true }))).toBe(false);
  });

  it('symbols: true —— 反引号作标点处理', () => {
    const r = locateExcerpt('value key', doc, { ignorePunctuation: { symbols: true } });
    expect(isHit(r)).toBe(true);
  });
});
