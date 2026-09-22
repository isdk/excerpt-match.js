/**
 * pickSeed 的属性测试 —— 钉住「毒化种子择优」的契约。
 *
 * @remarks
 * 集成测试能覆盖**一个**真实场景（md 标记 + 列表序号），但种子采样窗口有
 * 5 个、噪声注入位置任意，手写用例覆盖不全。属性测试用随机注入的噪声字符
 * 把整个输入空间扫一遍：
 *
 * - 噪声字符（`*#$1`）与内容字符（汉字）**严格不相交** —— 噪声绝不出现在
 *   hay 里，正是 `**`、`1.`、OCR 噪声在真实场景里的位置
 * - needle = 干净内容串 + 随机位置插入噪声，hay = 同一内容串（可重复）
 *
 * 属性见各 `it`。核心是「存在的窗口永远胜过不存在的」—— 旧代码会在首个
 * count=0 窗口处 break，本测试能抓住那个回归。
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { createBitapFallback, pickSeed } from './bitap';
import { lcsDiff, prefixMatch } from '../test/fakes';

const CONTENT = '甲乙丙丁戊己庚辛壬癸';
const NOISE = '*#$1';

const contentChar = fc.integer({ min: 0, max: CONTENT.length - 1 }).map((i) => CONTENT[i]!);
const noiseChar = fc.integer({ min: 0, max: NOISE.length - 1 }).map((i) => NOISE[i]!);

/** 一次「内容串 + 随机噪声注入」的场景：hay 与 needle 同源 */
const scenario = fc
  .tuple(
    // 用 chain 让长度均匀覆盖 8..60：既覆盖短 needle（全毒化区），
    // 也覆盖长 needle（存在干净窗口的毒化区）—— 只靠 fast-check 数组
    // 默认分布会编向 minLength，长 needle 场景几乎不出现
    fc.integer({ min: 8, max: 60 }).chain((n) => fc.array(contentChar, { minLength: n, maxLength: n })),
    fc.integer({ min: 1, max: 3 }), // hay 里内容串重复次数（制造多次出现）
    // 至少注入 1 个噪声字符，否则 needle 干净，毒化路径根本没被走到
    fc.array(fc.tuple(fc.integer({ min: 0, max: 28 }), noiseChar), { minLength: 1, maxLength: 6 })
  )
  .map(([chars, repeat, noise]) => {
    const base = chars.join('');
    const hay = `头${base.repeat(repeat)}尾`;
    let needle = base;
    // 按下标升序插入，保证同一下标的多次插入顺序确定
    for (const [pos, ch] of [...noise].sort((a, b) => a[0] - b[0])) {
      const at = pos % (needle.length + 1);
      needle = needle.slice(0, at) + ch + needle.slice(at);
    }
    return { hay, needle };
  });

/**
 * 复刻 pickSeed 的采样窗口（≤5 个、等距、长度 min(24, needle.length)）。
 *
 * 刻意与实现保持一致：采样策略一改，这里就会失败，逼迫同步更新 ——
 * 这本身就是「采样窗口」这一内部契约的文档。
 */
function triedWindows(needle: string, maxLen = 24): Array<{ seed: string; offset: number }> {
  const len = Math.min(maxLen, needle.length);
  const tries = Math.min(5, needle.length - len + 1);
  const out: Array<{ seed: string; offset: number }> = [];
  for (let k = 0; k < tries; k++) {
    const offset = tries === 1 ? 0 : Math.floor((k * (needle.length - len)) / (tries - 1));
    out.push({ seed: needle.slice(offset, offset + len), offset });
  }
  return out;
}

function presentCount(seed: string, hayChars: Set<string>): number {
  let n = 0;
  for (const ch of seed) if (hayChars.has(ch)) n++;
  return n;
}

describe('pickSeed 属性：毒化种子择优', () => {
  it('★ 存在的窗口胜出 —— 被采样窗口里有在原文出现的，返回的种子必在原文出现', () => {
    fc.assert(
      fc.property(scenario, ({ hay, needle }) => {
        const r = pickSeed(hay, needle);
        const windows = triedWindows(needle).filter((w) => w.seed.length >= 4);
        if (windows.length === 0) {
          // needle 短于 4：所有窗口都被 <4 过滤掉，没有可用锚点
          expect(r).toBeNull();
          return;
        }
        const anyPresent = windows.some((w) => hay.indexOf(w.seed) >= 0);
        if (anyPresent) {
          expect(r, '有存在窗口时不应返回 null').not.toBeNull();
          expect(hay.indexOf(r!.seed), '返回的种子必须在原文中出现').toBeGreaterThanOrEqual(0);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('返回的必是被采样窗口之一，且 offset/长度自洽', () => {
    fc.assert(
      fc.property(scenario, ({ hay, needle }) => {
        const r = pickSeed(hay, needle);
        const windows = triedWindows(needle).filter((w) => w.seed.length >= 4);
        if (windows.length === 0) {
          expect(r).toBeNull();
          return;
        }
        expect(r).not.toBeNull();
        const len = Math.min(24, needle.length);
        expect(r!.seed).toBe(needle.slice(r!.offset, r!.offset + len));
        expect(windows.some((w) => w.offset === r!.offset)).toBe(true);
      }),
      { numRuns: 500 }
    );
  });

  it('★ 全毒化时取「存在字符最多」的窗口（钉住备胎择优规则）', () => {
    fc.assert(
      fc.property(scenario, ({ hay, needle }) => {
        const r = pickSeed(hay, needle);
        const windows = triedWindows(needle).filter((w) => w.seed.length >= 4);
        if (windows.length === 0 || windows.some((w) => hay.indexOf(w.seed) >= 0)) return;
        // 走到这里：被采样窗口在原文中一次都不出现（全毒化）
        expect(r).not.toBeNull();
        const hayChars = new Set(hay);
        const best = presentCount(r!.seed, hayChars);
        for (const w of windows) {
          expect(presentCount(w.seed, hayChars), '备胎必须是存在字符最多的被采样窗口').toBeLessThanOrEqual(best);
        }
      }),
      { numRuns: 500 }
    );
  });

  it('确定性：同一输入两次调用结果相同', () => {
    fc.assert(
      fc.property(scenario, ({ hay, needle }) => {
        const a = pickSeed(hay, needle);
        const b = pickSeed(hay, needle);
        expect(b).toEqual(a);
      }),
      { numRuns: 200 }
    );
  });
});

// ────────────────────────────────────────────────────────────────
// 多命中（maxMatches / minScore）的属性
// ────────────────────────────────────────────────────────────────

/**
 * 分隔用的填充串。
 *
 * 长度必须 > `slack`(64)：否则窗口尾部的 slack 会够到**下一个** needle 的开头，
 * diff 的"末个共同段"被延伸过去，跨度虚高、命中区间连成一片 ——
 * 那就测不出遮蔽到底有没有生效了。
 */
const GAP = '。'.repeat(80);

/** needle 在 doc 里精确重复 repeat 次，中间用 GAP 隔开 */
const multiScenario = fc
  .record({
    chars: fc
      .integer({ min: 8, max: 30 })
      .chain((n) => fc.array(contentChar, { minLength: n, maxLength: n })),
    repeat: fc.integer({ min: 1, max: 4 }),
    maxMatches: fc.integer({ min: 1, max: 4 }),
    minScore: fc.constantFrom(0, 0.3, 0.9),
  })
  .map(({ chars, repeat, maxMatches, minScore }) => {
    const needle = chars.join('');
    const parts: string[] = [];
    for (let i = 0; i < repeat; i++) parts.push(GAP, needle);
    parts.push(GAP);
    return { doc: parts.join(''), needle, repeat, maxMatches, minScore };
  });

/** 在 needle 里注入噪声，让命中不再是精确匹配（更贴近真实） */
const noisyMultiScenario = multiScenario.chain((base) =>
  fc
    .array(fc.tuple(fc.integer({ min: 0, max: 28 }), noiseChar), { minLength: 1, maxLength: 4 })
    .map((noise) => {
      let needle = base.needle;
      for (const [pos, ch] of [...noise].sort((a, b) => a[0] - b[0])) {
        const at = pos % (needle.length + 1);
        needle = needle.slice(0, at) + ch + needle.slice(at);
      }
      return { ...base, needle };
    })
);

describe('createBitapFallback 属性：多命中', () => {
  it('★ 数量精确 = min(maxMatches, 实际出现次数) —— 遮蔽既不漏也不重', () => {
    fc.assert(
      fc.property(multiScenario, ({ doc, needle, repeat, maxMatches, minScore }) => {
        const find = createBitapFallback(prefixMatch, lcsDiff, { maxMatches, minScore });
        const r = find.find(needle, doc);
        expect(r).not.toBeNull();
        expect(r, '既不漏掉任何一处，也不重复计数').toHaveLength(Math.min(maxMatches, repeat));
      }),
      { numRuns: 150 }
    );
  });

  it('★ 命中区间互不重叠', () => {
    fc.assert(
      fc.property(noisyMultiScenario, ({ doc, needle, maxMatches, minScore }) => {
        const r = createBitapFallback(prefixMatch, lcsDiff, { maxMatches, minScore }).find(needle, doc);
        if (!r) return;
        const sorted = [...r].sort((a, b) => a.start - b.start);
        for (let i = 1; i < sorted.length; i++) {
          expect(sorted[i].start, '相邻命中不得重叠').toBeGreaterThanOrEqual(sorted[i - 1].end);
        }
      }),
      { numRuns: 150 }
    );
  });

  it('★ 数量不超过 maxMatches，且每一项都够 minScore', () => {
    fc.assert(
      fc.property(noisyMultiScenario, ({ doc, needle, maxMatches, minScore }) => {
        const r = createBitapFallback(prefixMatch, lcsDiff, { maxMatches, minScore }).find(needle, doc);
        if (!r) return;
        expect(r.length).toBeLessThanOrEqual(maxMatches);
        for (const m of r) {
          expect(m.score).toBeGreaterThanOrEqual(minScore);
          expect(m.score).toBeGreaterThan(0);
          expect(m.end).toBeGreaterThan(m.start);
          expect(m.start).toBeGreaterThanOrEqual(0);
          expect(m.end).toBeLessThanOrEqual(doc.length);
        }
      }),
      { numRuns: 150 }
    );
  });

  it('★ 结果按分数降序：out[0] 恒为最佳命中', () => {
    fc.assert(
      fc.property(noisyMultiScenario, ({ doc, needle, maxMatches, minScore }) => {
        const r = createBitapFallback(prefixMatch, lcsDiff, { maxMatches, minScore }).find(needle, doc);
        if (!r) return;
        for (let i = 1; i < r.length; i++) {
          expect(r[i - 1].score).toBeGreaterThanOrEqual(r[i].score);
        }
      }),
      { numRuns: 150 }
    );
  });

  it('★ 多命中不影响单命中的结果 —— 第 1 个恒等于 maxMatches=1 的结果', () => {
    fc.assert(
      fc.property(noisyMultiScenario, ({ doc, needle, minScore }) => {
        const one = createBitapFallback(prefixMatch, lcsDiff, { minScore }).find(needle, doc);
        const many = createBitapFallback(prefixMatch, lcsDiff, { maxMatches: 4, minScore }).find(needle, doc);
        if (!one || !many) {
          expect(many ?? null).toEqual(one ?? null);
          return;
        }
        // 兼容性核心：maxMatches 只会**追加**结果，绝不改变最佳命中
        expect(many[0]).toEqual(one[0]);
      }),
      { numRuns: 150 }
    );
  });

  it('★ 遮蔽哨兵不会泄漏进命中内容', () => {
    fc.assert(
      fc.property(noisyMultiScenario, ({ doc, needle, maxMatches, minScore }) => {
        const r = createBitapFallback(prefixMatch, lcsDiff, { maxMatches, minScore }).find(needle, doc);
        if (!r) return;
        for (const m of r) {
          const span = doc.slice(m.start, m.end);
          expect(span.length).toBeGreaterThan(0);
          expect(span, '命中内容必须来自原始 doc，不是被遮蔽的文本').not.toMatch(/[\u0000-\u0002\uE000]/);
        }
      }),
      { numRuns: 150 }
    );
  });
});
