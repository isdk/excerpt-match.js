import { describe, expect, it } from 'vitest';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { createMdastFlattener } from '@isdk/md-flatten';
import { normalizeWithMap } from '@isdk/normalize-text';
import { locateExcerpt, isHit } from './index';

const md = createMdastFlattener(fromMarkdown, { extensions: [gfm], mdastExtensions: [gfmFromMarkdown] });
const IGNORE = { ignorePunctuation: true as const };

/**
 * `punctFolded`：命中是否**跨越了标点差异**。
 *
 * 语义是「跨越了差异」，不是「折叠了标点」—— 后者在开启选项后会
 * 把所有命中都标 true，调用方就无从区分了。
 */
describe('punctFolded 的语义', () => {
  const doc = '本院认为，被告构成根本违约。';

  it('标点完全一致 → false（本就该 exact 命中，不该送复核）', () => {
    const r = locateExcerpt('本院认为，被告构成根本违约。', doc, IGNORE);
    expect(r.kind).toBe('exact');
    expect(r.punctFolded).toBe(false);
  });

  it('标点互换（逗号 ↔ 句号）→ true', () => {
    const r = locateExcerpt('本院认为。被告构成根本违约，', doc, IGNORE);
    expect(r.punctFolded).toBe(true);
  });

  it('摘录完全没有标点 → true', () => {
    const r = locateExcerpt('本院认为被告构成根本违约', doc, IGNORE);
    expect(r.punctFolded).toBe(true);
  });

  it('分号 vs 逗号 → true', () => {
    const r = locateExcerpt('本院认为；被告构成根本违约', doc, IGNORE);
    expect(r.punctFolded).toBe(true);
  });

  /**
   * 关键：**宽度差异不算**。全半角、中英标点由 ignoreWidth 处理，
   * 属于 T1 的常规归一，不需要人工复核。
   */
  it('★ 全半角 / 中英标点不算跨越差异', () => {
    const half = '本院认为,被告构成根本违约.';
    expect(locateExcerpt('本院认为，被告构成根本违约。', half, IGNORE).punctFolded).toBe(false);
    expect(locateExcerpt('本院认为,被告构成根本违约.', doc, IGNORE).punctFolded).toBe(false);
  });

  /**
   * 边缘上的**身份差异**要算：span 因归一化删掉首尾标点而不含末尾冒号，
   * 但页面侧会把紧邻的标点补进比较 —— 冒号就是冒号，不因为「在边上」而豁免。
   */
  it('★ 末尾标点身份不同（： ↔ 。）→ true：靠忽略标点才命中的，照送复核', () => {
    const colon = '本院认为，被告构成根本违约：';
    expect(locateExcerpt('本院认为，被告构成根本违约。', colon, IGNORE).punctFolded).toBe(true);
  });

  it('摘录是页面的字面前缀（页面末尾多一个句号）→ exact，谈不上跨差异', () => {
    // 摘录在页面里逐字符存在，T0 直接命中 —— 没有忽略任何东西，句号只是没被选进 span
    const r = locateExcerpt('本院认为，被告构成根本违约', doc, IGNORE);
    expect(r.kind).toBe('exact');
    expect(r.punctFolded).toBe(false); // exact 恒为 false：字面一致不可能跨差异
  });

  it('未开启 ignorePunctuation 时恒不为 true', () => {
    const r = locateExcerpt('本院认为被告构成根本违约', doc, { ignorePunctuation: false });
    expect(r.kind).toBe('none');
    expect(r.punctFolded).not.toBe(true);
  });

  /**
   * 回归（joined 视图）：无分隔符视图的 raw 剥掉了块间分隔符，相邻块直接贴在一起。
   * 边缘标点扩展若不夹回块边界，会把**下一块开头**的标点吞进页面侧 ——
   * 恰好凑成「相等」就把真差异假放行了（漏报）。
   *
   * 严格视图不需要这一层：raw 里的 `\n` 是 `Cc`，天然是扩展止点。
   */
  it('★ joined 跨块：摘录末尾句号在命中区域内无对应（来自下一块开头）→ true', () => {
    // 三个块：块3以「. 」开头。摘录 = 块1+块2拼接 + 末尾句号。
    // 大小写差异让 T0 miss，块间空白让严格视图 T1 miss，只有 joined 视图能中。
    const src = ['First part ends HERE', '', 'Second part begins', '', '. stray leading dot'].join('\n');
    const r = locateExcerpt('First part ends hereSecond part begins.', src, { markdown: md, ...IGNORE });
    expect(r.kind).toBe('normalized');
    expect(r.crossesBlocks).toBe(true);
    // span 本身不含下一块 —— 句号在命中区域里没有对应，必须送复核
    expect(src.slice(r.index, r.index + r.length)).not.toContain('stray');
    expect(r.punctFolded).toBe(true);
  });

  it('joined 跨块：两侧的边缘标点都真实存在且一致 → false（夹块边界不误伤正常扩展）', () => {
    // 页面块2以句号结尾，摘录同样带句号 —— 扩展在块内完成，应判定为无差异
    const src = ['First part ends HERE', '', 'Second part begins.', '', 'next block'].join('\n');
    const r = locateExcerpt('First part ends hereSecond part begins.', src, { markdown: md, ...IGNORE });
    expect(r.kind).toBe('normalized');
    expect(r.crossesBlocks).toBe(true);
    expect(r.punctFolded).toBe(false);
  });

  it('用户的调用范式可以区分两档', () => {
    const canCite = (r: { kind: string; punctFolded?: boolean }) =>
      r.kind === 'exact' || (r.kind === 'normalized' && !r.punctFolded);

    const strict = locateExcerpt('本院认为，被告构成根本违约。', doc, IGNORE);
    const crossed = locateExcerpt('本院认为被告构成根本违约', doc, IGNORE);
    expect(canCite(strict)).toBe(true);
    expect(canCite(crossed)).toBe(false);
    expect(isHit(crossed)).toBe(true); // 送人工复核而非丢弃
  });
});

describe('md 模式下不被语法标记干扰', () => {
  const src = '本院认为，**被告**的行为构成[根本违约](http://a.b/c)。';

  it('源码含 ** 与链接，不误判为标点差异', () => {
    const r = locateExcerpt('本院认为，被告的行为构成根本违约。', src, { markdown: md, ...IGNORE });
    expect(isHit(r)).toBe(true);
    expect(r.punctFolded).toBe(false);
  });

  it('md 下真正跨越标点仍能识别', () => {
    const r = locateExcerpt('本院认为被告的行为构成根本违约', src, { markdown: md, ...IGNORE });
    expect(isHit(r)).toBe(true);
    expect(r.punctFolded).toBe(true);
  });

  it('跨度精确：含语法标记', () => {
    const r = locateExcerpt('本院认为，被告的行为构成根本违约。', src, { markdown: md });
    expect(src.slice(r.index, r.index + r.length)).toBe(src);
  });
});

/**
 * 回归：normalizeWithMap 必须返回 back（归一化下标 → 输入下标）。
 *
 * 丢失 back 会导致三处静默失效：
 * 1. md 标记扩展（spanFromNormalized 的 expand 分支要求 hay.back）
 * 2. 块坐标换算（rebaseBlocks 用 hay.back）
 * 3. punctFolded 判定（spanWithEdgePunctuation 用 view.norm.back）
 */
describe('回归：归一化必须保留 back 映射', () => {
  it('纯文本：back 为恒等映射', () => {
    const r = normalizeWithMap('本院认为被告', { ignoreCase: true });
    expect(r.back).toBeDefined();
    expect(r.back!.length).toBeGreaterThan(0);
  });

  it('★ 长度变化时 back 仍正确指向输入', () => {
    // 数字分组会缩短文本，back 必须跳过被删掉的分隔符
    const r = normalizeWithMap('共1,000人', { numberGrouping: true, ignoreCase: false });
    expect(r.text).toBe('共1000人');
    expect(r.back).toBeDefined();
    // 输出「1000」的第一个 1 对应输入下标 1
    expect(r.back![1]).toBe(1);
    // 输出下标 4（'0' 后的 '0'）应跳过输入中的逗号（下标 3）
    expect(r.back![3]).toBe(4);
  });

  it('★ md 模式：T1 命中也要补齐行内标记（依赖 back）', () => {
    const src = '本院认为**被告**构成违约';
    const r = locateExcerpt('被告', src, { markdown: md });
    // 若 back 丢失，span 会是「被告」而不含 **
    expect(src.slice(r.index, r.index + r.length)).toBe('**被告**');
  });
});
