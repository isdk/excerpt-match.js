/**
 * 把 JSON 里的能力代号翻译成真实的 `MatchOptions`。
 *
 * fixture 必须是纯数据，没法直接塞一个 jieba 分词器或 diff-match-patch 实例进去。
 * 折中办法是 `use` 代号表 —— 新增一种可注入能力时改这里，而不是改 fixture。
 *
 * | 代号 | 注入 |
 * |---|---|
 * | `markdown` | mdast + GFM 摊平器（`.md` 文档自动加） |
 * | `markdown:regex` | 零依赖正则摊平器（坐标近似） |
 * | `dmp` | `diff-match-patch` 作 T3 fallback |
 * | `dmpEs` | `diff-match-patch-es` 作 T3 fallback |
 * | `jieba` | jieba 词性消歧的助词折叠器 |
 * | `cjk` | `cjk-number` 中文数词解析（同时开启 `cjkNumerals`） |
 * | `semantic` | 走 T4：用内置的确定性「假召回器」驱动 `locateSemantic` |
 * | `matcher` | 走**高层入口** `createExcerptMatcher`：md 摊平器与 T3 模糊层 |
 * |              | 都由内置默认装配（零配置链路），而不是 fixture 显式注入 |
 *
 * `semantic` 与 `dmp` 同用时，`dmp` 兼作 T4 的**段内再对齐器** ——
 * 这正是 README 推荐的「外部召回 + 段内确定性对齐」组合。
 *
 * `matcher` 刻意**不**附带 `markdown`：高层入口自己装配默认摊平器，
 * 这样测的才是用户开箱即用的那条链路（fixture 里另写 `markdown` 会变成显式注入）。
 */

import { createMdastFlattener, regexFlattener } from '@isdk/md-flatten';
import type { FallbackMatcher, MarkdownFlattener, SemanticRetriever } from '../src/index';
import { createDmpFallback, createDmpEsFallback } from '../src/index';

const KNOWN_USES = ['markdown', 'markdown:regex', 'dmp', 'dmpEs', 'jieba', 'cjk', 'semantic', 'matcher'] as const;

/**
 * 确定性的「假召回器」—— 按共有字符比例给段落打分。
 *
 * @remarks
 * T4 的召回本该由 embedding / BM25 提供，但集成测试要的是**可复现**，
 * 不能挂外部模型。这里用最简单的字符重叠模拟「召回了最像的那一段」：
 * 排序行为完全确定，足以验证 T4 的坐标翻译与门限编排。
 */
// 注意：召回器拿到的是 `string[]`（各段文本），不是 Segment 对象
const lexicalRetriever: SemanticRetriever = (excerpt, segments) =>
  segments
    .map((text, index) => {
      let common = 0;
      for (const ch of excerpt) if (text.includes(ch)) common += 1;
      return { index, score: common / Math.max(1, excerpt.length) };
    })
    .filter((s) => s.score > 0);

export interface ResolvedContext {
  /** 可直接交给 `createTextIndex` / `locateExcerpt` 的选项 */
  options: Record<string, unknown>;
  /** md 摊平器；纯文本模式为 undefined。runner 需要它来算 `visible` */
  markdown?: MarkdownFlattener;
  /** md 模式下文档是否被摊平（决定 `visible` 怎么算） */
  flattened: boolean;
  /** 是否走 T4（`locateSemantic`）而不是 `index.locate` */
  semantic?: boolean;
  /** T4 的召回器 */
  retriever?: SemanticRetriever;
  /** 是否走高层入口 `createExcerptMatcher`（零配置链路）而不是 `index.locate` */
  matcher?: boolean;
  /** T4 的段内再对齐器；不传则退化为高亮整段并降分 */
  aligner?: FallbackMatcher;
}

/**
 * 按需动态 import —— 可选依赖（jieba 的 wasm、cjk-number）不该拖慢不需要它们的 fixture。
 */
export async function resolveContext(
  use: readonly string[],
  options: Record<string, unknown>,
  at: string
): Promise<ResolvedContext> {
  for (const u of use) {
    if (!(KNOWN_USES as readonly string[]).includes(u)) {
      throw new Error(`${at}: 未知能力代号 "${u}"，可选：${KNOWN_USES.join(' / ')}`);
    }
  }

  const out: ResolvedContext = { options: { ...options }, flattened: false };

  if (use.includes('markdown')) {
    const { fromMarkdown } = await import('mdast-util-from-markdown');
    const { gfm } = await import('micromark-extension-gfm');
    const { gfmFromMarkdown } = await import('mdast-util-gfm');
    out.markdown = createMdastFlattener(fromMarkdown, {
      extensions: [gfm()],
      mdastExtensions: [gfmFromMarkdown()],
    }) as unknown as MarkdownFlattener;
    out.options.markdown = out.markdown;
    out.flattened = true;
  } else if (use.includes('markdown:regex')) {
    out.markdown = regexFlattener as unknown as MarkdownFlattener;
    out.options.markdown = out.markdown;
    out.flattened = true;
  }

  if (use.includes('dmp')) {
    const { diff_match_patch } = await import('diff-match-patch');
    out.options.fallbacks = [createDmpFallback(new diff_match_patch())];
  } else if (use.includes('dmpEs')) {
    const dmpEs = await import('diff-match-patch-es');
    out.options.fallbacks = [createDmpEsFallback(dmpEs)];
  }

  if (use.includes('jieba')) {
    const jieba = await import('@isdk/nlp-jieba');
    const { createJiebaParticleTagger } = await import('@isdk/zh-particles');
    out.options.ignoreParticles = createJiebaParticleTagger(jieba);
  }

  if (use.includes('cjk')) {
    const cjk = await import('cjk-number');
    const { createCjkNumberParser } = await import('@isdk/normalize-text');
    out.options.cjkNumerals = true;
    out.options.cjkNumeralParser = createCjkNumberParser(cjk);
  }

  if (use.includes('semantic')) {
    out.semantic = true;
    out.retriever = lexicalRetriever;
    // 有注入 dmp 就让它兼作段内对齐器 —— 召回给粗位置，对齐给精确坐标
    const fallbacks = out.options.fallbacks as FallbackMatcher[] | undefined;
    if (fallbacks?.length) out.aligner = fallbacks[0];
  }

  if (use.includes('matcher')) {
    // 高层入口自己装配 md 摊平器与 T3 模糊层：这里只做标记，
    // 不往 options 里塞任何能力 —— 否则测的就不是「零配置」链路了。
    // 需要收紧时在 case.json 里写 options（如 `fallbacks: []` 关掉模糊层）。
    out.matcher = true;
  }

  return out;
}
