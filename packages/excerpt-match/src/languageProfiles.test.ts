import { describe, expect, it, beforeEach } from 'vitest';
import {
  detectLanguageProfile,
  languageProfileFor,
  tokenize,
  wordSegmenterCacheSize,
  resetWordSegmenterCache,
} from './languageProfiles';

/**
 * 分词器缓存：为什么需要它，以及为什么是二层。
 *
 * `locale` 可能来自用户输入，若无界缓存，长驻服务里 locale 变体会不断累积
 * （`zh-CN` / `zh-Hans-CN` / `zh-Hans-CN-u-co-pinyin` …）—— 内存泄漏入口。
 */
describe('分词器缓存（secondary-cache 二层）', () => {
  beforeEach(() => resetWordSegmenterCache());

  it('内置语言的 locale 放 fixed 层，永不被淘汰', () => {
    const builtins = ['zh', 'en', 'ja', 'ko', 'th'];
    builtins.forEach((l) => tokenize('测试 test', languageProfileFor(l)));
    const afterBuiltins = wordSegmenterCacheSize();

    // 塞入远超 LRU 容量的用户 locale
    for (let i = 0; i < 100; i++) tokenize('x', languageProfileFor(`xx-locale-${i}`));

    expect(wordSegmenterCacheSize()).toBeLessThanOrEqual(afterBuiltins + 32);
    // 关键：内置 locale 全部保留
    builtins.forEach((l) => {
      expect(tokenize('测试 test', languageProfileFor(l)).length).toBeGreaterThan(0);
    });
  });

  it('用户 locale 受 LRU 容量约束，不会无界增长', () => {
    for (let i = 0; i < 500; i++) tokenize('x', languageProfileFor(`user-${i}`));
    // 5 个内置 + 上限 32
    expect(wordSegmenterCacheSize()).toBeLessThanOrEqual(5 + 32);
  });

  it('高频 locale 命中缓存，不重复构造 Segmenter', () => {
    resetWordSegmenterCache();
    const a = tokenize('the court held', languageProfileFor('en'));
    const n1 = wordSegmenterCacheSize();
    const b = tokenize('another sentence', languageProfileFor('en'));
    const n2 = wordSegmenterCacheSize();
    expect(a).toEqual(['the', 'court', 'held']);
    expect(b).toEqual(['another', 'sentence']);
    expect(n2).toBe(n1); // 复用，没有新增条目
  });

  it('reset 后缓存归零', () => {
    tokenize('x', languageProfileFor('en'));
    expect(wordSegmenterCacheSize()).toBeGreaterThan(0);
    resetWordSegmenterCache();
    expect(wordSegmenterCacheSize()).toBe(0);
  });
});

describe('语言策略', () => {
  it('已知 locale 精确匹配', () => {
    expect(languageProfileFor('zh').granularity).toBe('char');
    expect(languageProfileFor('en').granularity).toBe('word');
    expect(languageProfileFor('ja').segmenterLocale).toBe('ja');
  });

  it('带地区的 locale 回退到基础语言', () => {
    expect(languageProfileFor('zh-Hans-CN').id).toBe('cjk');
    expect(languageProfileFor('en-US').granularity).toBe('word');
  });

  it('未知 locale 保守走词级', () => {
    const p = languageProfileFor('xx-invented');
    expect(p.granularity).toBe('word');
    expect(p.segmenterLocale).toBe('xx-invented');
  });

  it('空文本返回默认策略', () => {
    expect(detectLanguageProfile('').id).toBe('default');
  });

  it('ICU 词典不足时（整段切成 1 个 token）退回字级', () => {
    // 走 word 粒度的语言，若分词器把整段 CJK 切成 1 个 token，应退回字级
    const p = languageProfileFor('ja');
    const toks = tokenize('契約違反による損害賠償', p);
    expect(toks.length).toBeGreaterThan(1);
  });
});
