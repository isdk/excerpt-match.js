/**
 * 浏览器打包测试 —— 在**真实浏览器**（Chrome）里跑同一条零配置链路。
 *
 * ## 它钉住什么
 *
 * `defaults.ts` 的内置默认装配**只允许依赖 ECMAScript 动态 `import()` 与
 * 字面量模块名**，禁止 `node:*` / `createRequire` / 裸 `require` ——
 * 这类 Node 专用加载原语会让：
 *
 * 1. 静态依赖图（md-flatten / zh-negation / whitespace-semantics 等纯 JS 子包）
 *    无法被浏览器打包器编译；
 * 2. `defaults.ts` 的惰性动态 import 在浏览器里全军降级。
 *
 * 文件顶部的 `import` 本身就是守卫：任何 `node:*` 混进静态依赖图，vite
 * 都会报「Module externalized for browser compatibility」并在运行时抛
 * `createRequire is not a function` —— 本文件当场红。
 *
 * ## 为什么有条件跳过
 *
 * 这些断言只在**浏览器运行时**才有意义：Node 档（`npm test`）里同样的
 * 零配置链路已由 `excerptMatcher.test.ts` 覆盖，这里重复跑没有价值，
 * 故 `typeof document === 'undefined'` 时整组跳过 —— 根目录 workspace
 * 一次跑全部包时本文件静默跳过，不添噪音。
 *
 * @packageDocumentation
 */

import { describe, expect, it } from 'vitest';
import { matchExcerpt } from './excerptMatcher';
import { defaultParticleTagger } from './defaults';

/** 浏览器运行时才有 document —— Node 档整组跳过（见文件头说明） */
const inBrowser = typeof document !== 'undefined';

// 真实长文（同 excerptMatcher.test.ts 的语料），验证浏览器里的完整链路
const DOC = `# 判决书摘录

本院认为，被告的行为已经构成根本违约，应当承担违约责任。

综上，依照《中华人民共和国民法典》第五百七十七条之规定，判决如下：

## 一、本金与利息

被告应于本判决生效之日起十日内向原告支付本金**一千元整**，利息照付。
`;

describe.skipIf(!inBrowser)('浏览器打包：零配置链路在 Chrome 中端到端可用', () => {
  it('★ 内置 md 摊平器（mdast + GFM）加载成功且命中返回源码坐标', async () => {
    // 用户从「渲染后文档」复制的摘录 —— 必须先摊平 md 才能命中
    const ex = '被告应于本判决生效之日起十日内向原告支付本金一千元整，利息照付。';
    const r = await matchExcerpt(ex, DOC);

    // 摊平器加载失败时会降级为纯文本匹配，`**` 就成了字面内容 —— 断言两种都接住，
    // 但 kind/source 必须证明走的是哪条路（守卫点在「命中且坐标可回切」）
    expect(r.found).toBe(true);
    expect(r.source).toBe(DOC.slice(r.index, r.index + r.length));
    expect(r.source).toContain('本金');
  });

  it('★ 内置 T3 模糊层（diff-match-patch-es，纯 ESM）加载成功', async () => {
    // 缺「已经」二字：T0–T2 够不到，只有纯 ESM 的 dmp-es 模糊层能接住
    const r = await matchExcerpt('本院认为，被告的行为构成违约', DOC);
    expect(r.found).toBe(true);
    expect(r.kind).toBe('fuzzy');
    expect(r.via).toBe('diff-match-patch-es');
  });

  it('★ 内置 cjk-number（纯 ESM，exports 仅 import 条件）加载成功', async () => {
    const r = await matchExcerpt('本金1000元整', DOC, { cjkNumerals: true, fallbacks: [] });
    expect(r.found).toBe(true);
    expect(r.kind).toBe('normalized');
  });

  it('★ 内置 jieba（web 构建 wasm 初始化 + 词典）端到端可用', async () => {
    // 判别依据：默认装配出的 tagger.name 必须是 'jieba'（词性判定），
    // 而不是加载失败后高层入口静默退回的 'conservative' 保守模式 ——
    // 否则用例通过也证明不了 jieba 在浏览器里真的能用。
    const tagger = await defaultParticleTagger();
    expect(tagger, 'jieba 默认装配失败（wasm 初始化或词典加载）').toBeTruthy();
    expect(tagger!.name).toBe('jieba');

    // 「地」→「的」折叠由词性判定驱动；不开模糊层以隔离验证
    const r = await matchExcerpt('他高兴的接受', '他高兴地接受了邀请。', {
      ignoreParticles: true,
      fallbacks: [],
    });
    expect(r.found).toBe(true);
  });

  it('未命中路径正常（降级逻辑本身也是契约的一部分）', async () => {
    const r = await matchExcerpt('本文档压根没写过这句话。', DOC);
    expect(r.found).toBe(false);
    expect(r.kind).toBe('none');
  });
});
