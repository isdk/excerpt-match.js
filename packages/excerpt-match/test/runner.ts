/**
 * 执行 fixture 并把结果交给 `@isdk/match-ex` 匹配。
 *
 * ## `expect` 匹配的是 `ActualResult`，而不是裸的 `ExcerptMatch`
 *
 * 除了定位结果本身，runner 还补出几个**派生字段**，让 fixture 能断言更有意义的东西：
 *
 * | 字段 | 含义 |
 * |---|---|
 * | `span` | `doc.slice(index, index+length)` —— md 模式下含语法标记的源码片段 |
 * | `visible` | 同一片段**摊平后**的可见文本，即用户实际看到 / 复制到的那段字 |
 * | `line` | `index` 所在的 1-based 行号 |
 * | `hit` | `isHit(result)` 的布尔形式 |
 *
 * `visible` 比 `span` 更能说明「到底匹配到了什么」：md 模式下
 * `span` 里混着 `**`、`[](url)`，而 `visible` 就是页面上那句话。
 *
 * ## 不变式
 *
 * 坐标契约这类「对每个 fixture 都该成立」的检查不用写进 `case.json`，
 * runner 自动附加（可用 `invariants: false` 关闭）。
 */

import { validate, ValidationContext } from '@isdk/match-ex';
import type { MatchFailure } from '@isdk/match-ex';
import { createTextIndex, isHit, locateSemantic, type ExcerptMatch, type TextIndex } from '../src/index';
import type { LoadedCase, LoadedFixture, RawOptions } from './fixture';
import { isRegexSpec, toRegExp } from './fixture';
import { resolveContext, type ResolvedContext } from './capabilities';

/** 交给 `expect` 匹配的实际结果：定位结果 + 派生字段 */
export interface ActualResult {
  hit: boolean;
  index: number;
  length: number;
  kind: string;
  score: number;
  occurrences: number;
  crossesBlocks?: boolean;
  via?: string;
  punctFolded?: boolean;
  /** 源码片段；未命中为空串 */
  span: string;
  /** 摊平后可见文本；未命中为空串 */
  visible: string;
  /** 1-based 行号；未命中为 -1 */
  line: number;
}

/**
 * 索引缓存。
 *
 * 一个 fixture 里的多条摘录共用同一份文档时应当复用索引 ——
 * 这正是 README 里强调的用法顺手变成测试的一部分。
 */
const indexCache = new Map<string, Promise<ResolvedIndex>>();

interface ResolvedIndex {
  ctx: ResolvedContext;
  index: TextIndex;
}

/** 缓存键必须带上 fixture 标识 —— 否则不同 fixture 会串用同一份文档 */
function optionsKey(id: string, use: readonly string[], options: RawOptions): string {
  return JSON.stringify([id, use, options]);
}

async function buildIndex(fx: LoadedFixture, options: RawOptions, use: readonly string[]): Promise<ResolvedIndex> {
  const key = optionsKey(fx.id, use, options);
  const hit = indexCache.get(key);
  if (hit) return hit;

  const task = (async () => {
    const ctx = await resolveContext(use, normalizeOptions(options, fx.file), fx.file);
    return { ctx, index: createTextIndex(fx.raw, ctx.options as never) };
  })();
  indexCache.set(key, task);
  return task;
}

/**
 * 把 JSON 友好的选项转成真正的 `MatchOptions`。
 *
 * 目前只有一处需要翻译：`ellipsis` 里的 `{ regex, flags }`。
 * 其余键名与 `MatchOptions` 完全同名同义，直接透传。
 */
function normalizeOptions(options: RawOptions, at: string): RawOptions {
  const out: RawOptions = { ...options };
  if (Array.isArray(out.ellipsis)) {
    out.ellipsis = out.ellipsis.map((p, i) =>
      isRegexSpec(p) ? toRegExp(p, `${at} > ellipsis[${i}]`) : p
    );
  }
  return out;
}

/**
 * 算 `visible`：把源码坐标区间换算回「摊平后的可见文本」。
 *
 * md 模式下 `map[i]` 是第 i 个可见字符的源码起点，
 * 所以落在 `[index, index+length)` 里的那些字符就是本次命中的可见内容。
 */
function visibleOf(ctx: ResolvedContext, raw: string, res: ExcerptMatch): string {
  if (res.index < 0) return '';
  const end = res.index + res.length;
  if (!ctx.flattened || !ctx.markdown) return raw.slice(res.index, end);

  const flat = ctx.markdown.flatten(raw);
  const { map, text } = flat;
  // md-flatten 保证 map 与 text **按 code unit 对齐**（代理对拆成两条共享同一源码区间），
  // 所以这里可以直接按下标切片
  let lo = -1;
  let hi = -1;
  for (let i = 0; i < text.length; i++) {
    const src = map[i];
    if (src >= res.index && src < end) {
      if (lo < 0) lo = i;
      hi = i;
    }
  }
  return lo < 0 ? '' : text.slice(lo, hi + 1);
}

function lineOf(raw: string, index: number): number {
  if (index < 0) return -1;
  let line = 1;
  for (let i = 0; i < index; i++) if (raw[i] === '\n') line++;
  return line;
}

/** 把定位结果摊平成 `expect` 的形状 */
function toActual(ctx: ResolvedContext, raw: string, res: ExcerptMatch): ActualResult {
  return {
    hit: isHit(res),
    index: res.index,
    length: res.length,
    kind: res.kind,
    score: res.score,
    occurrences: res.occurrences,
    crossesBlocks: res.crossesBlocks,
    via: res.via,
    punctFolded: res.punctFolded,
    span: res.index >= 0 ? raw.slice(res.index, res.index + res.length) : '',
    visible: visibleOf(ctx, raw, res),
    line: lineOf(raw, res.index),
  };
}

/**
 * 通用不变式 —— 每个 fixture 都该成立，不需要写进 `case.json`。
 *
 * 命中最容易腐坏的是坐标契约（`slice(index, index+length)` 必须落在原文里），
 * 未命中则要守住 `NO_MATCH` 的确切形状。
 */
function checkInvariants(actual: ActualResult, raw: string, options: RawOptions): MatchFailure[] {
  const failures: MatchFailure[] = [];
  const bad = (key: string, message: string) => failures.push({ key, message });

  if (actual.hit) {
    if (actual.index < 0) bad('index', `命中时 index 不能为负，实际 ${actual.index}`);
    if (actual.length <= 0) bad('length', `命中时 length 必须为正，实际 ${actual.length}`);
    if (actual.index + actual.length > raw.length) {
      bad('length', `span 越界：index+length=${actual.index + actual.length} > 文档长度 ${raw.length}`);
    }
    if (actual.occurrences < 1) bad('occurrences', `命中时 occurrences 至少为 1，实际 ${actual.occurrences}`);
    if (actual.score < 0 || actual.score > 1) bad('score', `score 必须落在 [0,1]，实际 ${actual.score}`);
    if (actual.kind === 'none') bad('kind', 'isHit 为真时 kind 不能是 none');
  } else {
    if (actual.index !== -1 || actual.length !== 0 || actual.score !== 0 || actual.occurrences !== 0) {
      bad('index', `未命中必须是 NO_MATCH(index=-1,length=0,score=0,occurrences=0)，实际 ${JSON.stringify(actual)}`);
    }
  }

  // 严格档的核心承诺：不给 fallbacks 就绝不会有模糊匹配
  if (options.preset === 'strict' && options.fallbacks === undefined) {
    if (actual.kind === 'fuzzy' || actual.kind === 'semantic') {
      bad('kind', `strict 档且未注入 fallbacks 时不该出现 ${actual.kind}`);
    }
  }
  return failures;
}

async function matchExpectation(actual: ActualResult, expect: Record<string, unknown>): Promise<MatchFailure[]> {
  const ctx = new ValidationContext({ disableHeuristicSchema: true });
  const res = await validate(actual, expect, ctx);
  return res.pass ? [] : res.failures;
}

export interface CaseResult {
  failures: MatchFailure[];
  actual: ActualResult;
}

export async function runCase(fx: LoadedFixture, c: LoadedCase): Promise<CaseResult> {
  const { ctx, index } = await buildIndex(fx, c.options, c.use);
  // T4 走另一条入口：外部召回 + 段内再对齐，而不是 index.locate 的 T0–T3 分层
  const res = ctx.semantic && ctx.retriever
    ? await locateSemantic(index, c.excerpt, ctx.retriever, { ...c.options, aligner: ctx.aligner } as never)
    : index.locate(c.excerpt);
  const actual = toActual(ctx, fx.raw, res);

  const failures: MatchFailure[] = [];
  failures.push(...(await matchExpectation(actual, c.expect)));
  if (fx.invariants) failures.push(...checkInvariants(actual, fx.raw, c.options));
  return { failures, actual };
}

/** 失败信息格式化：带上 fixture 路径，让 CI 日志能直接定位到文件 */
export function formatFailures(fx: LoadedFixture, c: LoadedCase, failures: MatchFailure[]): string {
  const head = `${fx.id} › ${c.name}\n  fixture: test/fixtures/${fx.id}/case.json`;
  const lines = failures.map((f) => {
    const at = f.key ? `[${f.key}] ` : '';
    const expected = f.expected !== undefined ? `\n      期望: ${JSON.stringify(f.expected)}` : '';
    const actualV = f.actual !== undefined ? `\n      实际: ${JSON.stringify(f.actual)}` : '';
    return `  ✗ ${at}${f.message ?? 'mismatch'}${expected}${actualV}`;
  });
  return [head, ...lines].join('\n');
}
