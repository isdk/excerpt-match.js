import { Cache } from 'secondary-cache';
import { unicodeScriptOf } from '@isdk/whitespace-semantics';
/**
 * 语言策略。语言相关的一切都收敛在这里，核心算法保持语言无关。
 *
 * 语言只影响三件事：
 * 1. CJK 相邻处是否删除空白（中文排版换行不产生空格，英文必须保留）
 * 2. T3 / T4 用字级还是词级切词
 * 3. 用哪个 locale 初始化 `Intl.Segmenter`
 *
 * @remarks
 * 三条经验：
 * 1. 中 / 日 / 泰文没有空格，不能套用英文的「词边界」直觉；反过来英文用字符级
 *    对齐会被 4 字短种子淹没（`that` 满篇都是）。
 * 2. 分词用 `Intl.Segmenter`（浏览器与 Node 18+ 内置，依赖 ICU 词典），
 *    不需要 nodejieba 这类原生模块。
 */
export interface LanguageProfile {
  /** 语言 id，如 `'cjk'` / `'ja'` / `'th'` / `'default'` */
  id: string;
  /** CJK 相邻时是否删除空白（中文排版换行不产生空格，英文必须保留） */
  dropSpaceBetweenCJK: boolean;
  /**
   * T3 / T4 用的分词粒度。
   *
   * @remarks
   * 中文走 `char`：短摘录（十几字）做词级模糊匹配，召回反而不如字级稳定。
   * 英文必须 `word`：字级会让 4 字符种子满篇都是，定位退化。
   */
  granularity: 'char' | 'word';
  /** 传给 `Intl.Segmenter` 的 locale，用于 `word` 粒度 */
  segmenterLocale: string;
}

const CHINESE_PROFILE: LanguageProfile = {
  id: 'cjk',
  dropSpaceBetweenCJK: true,
  granularity: 'char',
  segmenterLocale: 'zh',
};

const FALLBACK_PROFILE: LanguageProfile = {
  id: 'default',
  dropSpaceBetweenCJK: true, // 只删「CJK 之间」的空白，英文不受影响
  granularity: 'word',
  segmenterLocale: 'en',
};

const PROFILES_BY_LOCALE: Record<string, LanguageProfile> = {
  zh: CHINESE_PROFILE, 'zh-cn': CHINESE_PROFILE, 'zh-tw': CHINESE_PROFILE, 'zh-hant': CHINESE_PROFILE,
  ja: { ...CHINESE_PROFILE, id: 'ja', segmenterLocale: 'ja', granularity: 'word' },
  ko: { ...CHINESE_PROFILE, id: 'ko', segmenterLocale: 'ko', granularity: 'word' },
  th: { ...CHINESE_PROFILE, id: 'th', segmenterLocale: 'th', granularity: 'word' }, // 泰文无空格但 ICU 能切
  en: FALLBACK_PROFILE,
};

/**
 * 按语言代码取策略。未知语言回退到 `{@link LanguageProfile.granularity} = 'word'` 的默认策略。
 *
 * @param locale BCP-47 语言代码，如 `'zh'`、`'ja'`、`'en'`、`'th'`、`'zh-Hant'`
 * @returns 语言策略
 *
 * @example
 * ```ts
 * languageProfileFor('zh').granularity; // 'char'
 * languageProfileFor('en').granularity; // 'word'
 * ```
 */
export function languageProfileFor(locale: string): LanguageProfile {
  const key = locale.toLowerCase();
  if (PROFILES_BY_LOCALE[key]) return PROFILES_BY_LOCALE[key];
  const base = key.split('-')[0];
  return PROFILES_BY_LOCALE[base] ?? { ...FALLBACK_PROFILE, segmenterLocale: locale || 'en' };
}

/** 语言探测只看前 N 个字符，长文不会因此变慢 */
const LANGUAGE_DETECTION_SAMPLE_SIZE = 2000;
/** 构造 `Intl.Segmenter` 失败时（非法 locale）使用的兜底 locale */
const FALLBACK_SEGMENTER_LOCALE = 'en';

/** LRU 层上限：用户传入的 locale 最多缓存多少个 */
const WORD_SEGMENTER_LRU_SIZE = 32;
/** fixed 层上限：内置语言的 locale 数（有界即可，实际是有限的） */
const WORD_SEGMENTER_FIXED_SIZE = 64;
/** 少数派脚本要压过这个比例才据此判定语言 */
const MINORITY_SCRIPT_RATIO = 0.15;

/**
 * 按**字符占比**探测语言，而不是「见到一个就判定」。
 *
 * @remarks
 * 朴素实现（`/[\u3040-\u30ff]/.test(sample)`）会把「大量汉字 + 一个假名」
 * 的中文文档误判成日文；日文文档里出现个别韩文也会把整篇翻成韩文。
 *
 * 正确做法是**按脚本统计占比并设最低阈值**：
 * 占比太低说明只是引文或注音，不足以决定整篇的策略。
 *
 * 为什么不用 `franc` 这类语言识别库：它们面向整段自然语言的统计分类，
 * 对 CJK 混排（中日韩共用汉字）并不比脚本占比更可靠，却要多带几百 KB 数据。
 * 本库只需要决定「分词粒度 + 空格策略」，脚本占比足够。
 *
 * @param text 待探测文本
 * @returns 语言策略
 *
 * @example
 * ```ts
 * detectLanguageProfile('本院认为被告构成根本违约').id;   // 'cjk'
 * detectLanguageProfile('本院认为被告构成根本违约，契約').id; // 'cjk'（一个假名不改变判定）
 * detectLanguageProfile('契約違反による損害賠償請求').id;  // 'ja'
 * ```
 */
export function detectLanguageProfile(text: string): LanguageProfile {
  const sample = text.slice(0, LANGUAGE_DETECTION_SAMPLE_SIZE);
  if (sample.length === 0) return FALLBACK_PROFILE;

  const counts = { han: 0, kana: 0, hangul: 0, thai: 0, latin: 0 };
  for (const ch of sample) {
    const script = unicodeScriptOf(ch.codePointAt(0) as number);
    if (script in counts) counts[script as keyof typeof counts]++;
  }
  const total = counts.han + counts.kana + counts.hangul + counts.thai + counts.latin;
  if (total === 0) return FALLBACK_PROFILE;

  // 汉字是东亚通用字符，只有「少数派脚本占比够高」才据此改判语言
  if (counts.kana / total >= MINORITY_SCRIPT_RATIO) return PROFILES_BY_LOCALE.ja;
  if (counts.hangul / total >= MINORITY_SCRIPT_RATIO) return PROFILES_BY_LOCALE.ko;
  if (counts.thai / total >= MINORITY_SCRIPT_RATIO) return PROFILES_BY_LOCALE.th;
  if (counts.han / total >= MINORITY_SCRIPT_RATIO) return CHINESE_PROFILE;
  return FALLBACK_PROFILE;
}

/**
 * 分词器缓存：**二层结构**（`secondary-cache`）。
 *
 * | 层 | 放什么 | 会不会被淘汰 |
 * |---|---|---|
 * | **fixed** | 内置语言的 locale（`zh` / `en` / `ja` / `ko` / `th`…） | **永不** |
 * | LRU | 调用方传入的任意 locale | 会，超出上限淘汰 |
 *
 * @remarks
 * 为什么是二层而不是普通 LRU：
 *
 * `locale` 来自**用户输入**，若用无界 `Map`，长驻服务里会因 locale 变体
 * （`zh-CN` / `zh-Hans-CN` / `zh-Hans-CN-u-co-pinyin` …）不断累积而膨胀 ——
 * 相当于一个内存泄漏入口。
 *
 * 但纯 LRU 又有个代价：哪怕只有少数几个语言，高频使用的内置 locale
 * 也可能被大量生僻 locale 挤掉，然后反复重建 `Intl.Segmenter`（不便宜）。
 *
 * 二层结构正好对应这两种性质的键：**已知有限的放 fixed，未知无限的放 LRU**。
 * 实测塞入 100 个用户 locale 后，5 个内置 locale 全部保留。
 */
const wordSegmenterCache = new Cache({
  capacity: WORD_SEGMENTER_LRU_SIZE, // 注意字段名是 capacity，不是 max
  fixedCapacity: WORD_SEGMENTER_FIXED_SIZE,
});

/** 内置语言的 locale，放 fixed 层保证不被淘汰 */
const BUILTIN_LOCALES = new Set(
  Object.keys(PROFILES_BY_LOCALE).filter((k) => !k.includes('-'))
);

/**
 * 取（或构造）分词器。
 *
 * @remarks
 * **必须容错**：`locale` 可能来自用户输入，而
 * `new Intl.Segmenter('xx-locale-0')` 会抛 `RangeError: Incorrect locale information provided`。
 * 未捕获的话，一个非法输入就能让整个定位流程崩溃。
 *
 * 非法 locale 退化为**默认分词器**并照样缓存（避免每次都重试构造）。
 */
/**
 * 取（或构造 + 缓存）词级分段器。
 *
 * 导出供 {@link detectNegation} 等内部模块复用 ——
 * **只应有一份缓存**，各自持有一份会让容量约束失效。
 */
export function getWordSegmenter(locale: string): Intl.Segmenter {
  const cached = wordSegmenterCache.get(locale);
  if (cached) return cached as Intl.Segmenter;
  let seg: Intl.Segmenter;
  try {
    seg = new Intl.Segmenter(locale, { granularity: 'word' });
  } catch {
    // 非法 locale：退化为默认，并记在该键下，避免反复构造
    seg = new Intl.Segmenter(FALLBACK_SEGMENTER_LOCALE, { granularity: 'word' });
  }
  // 内置语言 → fixed 层；其余（用户传入）→ LRU 层
  if (BUILTIN_LOCALES.has(locale.toLowerCase())) wordSegmenterCache.setFixed(locale, seg);
  else wordSegmenterCache.set(locale, seg);
  return seg;
}

/**
 * 缓存当前条目数，供测试与运维观察。
 *
 * @remarks
 * 正常应稳定在 `内置语言数 + 最近用过的用户 locale 数` 附近；
 * 若持续增长说明有 locale 变体轰炸（无界时就是泄漏）。
 */
export function wordSegmenterCacheSize(): number {
  return wordSegmenterCache.length();
}

/** 仅供测试：清空分词器缓存 */
export function resetWordSegmenterCache(): void {
  wordSegmenterCache.reset({ capacity: WORD_SEGMENTER_LRU_SIZE, fixedCapacity: WORD_SEGMENTER_FIXED_SIZE });
}

/**
 * 按语言策略切词，供 T3 / T4 使用。
 *
 * 用内置的 `Intl.Segmenter`（依赖 ICU 词典），不需要原生模块。
 *
 * @remarks
 * 兜底：若分词器把整段 CJK 切成了**一个** token（ICU 词典不足时会这样），
 * 词级对齐就退化了 —— 此时退化为字级。
 *
 * @param text 待切分文本
 * @param profile 语言策略
 * @returns token 数组
 *
 * @example
 * ```ts
 * tokenize('本院认为', languageProfileFor('zh'));       // ['本','院','认','为']
 * tokenize('the court held', languageProfileFor('en')); // ['the','court','held']
 * ```
 */
export function tokenize(text: string, profile: LanguageProfile): string[] {
  if (profile.granularity === 'char') return Array.from(text);
  const seg = getWordSegmenter(profile.segmenterLocale);
  const out: string[] = [];
  for (const s of seg.segment(text)) if (s.isWordLike) out.push(s.segment);
  // ICU 词典不足时整段会被切成 1 个 token，词级对齐会退化 —— 退回字级
  if (out.length === 1 && out[0].length > 1 && /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(out[0])) {
    return Array.from(text);
  }
  return out;
}
