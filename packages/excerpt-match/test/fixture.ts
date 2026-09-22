/**
 * fixture 的加载、规范化与执行排期。
 *
 * ## 目录约定
 *
 * ```
 * test/fixtures/<场景>/
 *   case.json   输入 + 测试配置 + 期望输出
 *   doc.md      待测文本（默认名，可用 `doc` 字段改）
 * ```
 *
 * ## 能省则省
 *
 * | 字段 | 省略时的行为 |
 * |---|---|
 * | `doc` | 取目录下的 `doc.md` |
 * | `description` | 取目录名 |
 * | `use` | `.md` 结尾时自动加 `markdown` |
 * | `options` | `{}` |
 * | `invariants` | `true` |
 * | `cases[].name` | 取摘录文本 |
 *
 * `cases` 支持**单条对象**或**数组**两种写法 —— 一个目录通常承载同一主题下的若干条摘录。
 */

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT_DIR = resolve(fileURLToPath(new URL('../', import.meta.url)));
export const FIXTURES_DIR = join(ROOT_DIR, 'test', 'fixtures');

/** case.json 里 `options` 的形状 —— 一切值都必须可由 JSON 表达 */
export type RawOptions = Record<string, unknown>;

/** 期望输出。语义见 match-ex：`对象=包含匹配`，字符串默认子串，`"/re/flags"` 为正则 */
export type Expectation = Record<string, unknown>;

/** `{ "regex": "...", "flags": "i" }` —— JSON 里表达 RegExp 的显式写法 */
export interface RegexSpec {
  regex: string;
  flags?: string;
}

/**
 * `skip` / `only` 两级都支持：**fixture 级**（整个目录）与**用例级**（`cases[]` 的某一项）。
 *
 * | 组合 | 结果 |
 * |---|---|
 * | `skip` vs `only` | `skip` 赢 —— 挂起永远优先，避免调试时误跑掉已知失败的用例 |
 * | 某个 fixture 标 `only` | 只有带 `only` 的 fixture 执行 |
 * | 某个用例标 `only` | 该 fixture 内只有带 `only` 的用例执行 |
 */
export interface CaseDecl {
  /** 用例名；省略时取摘录文本 */
  name?: string;
  /** 待定位的摘录（默认来自渲染后页面） */
  excerpt: string;
  /** 用例级选项，覆盖 fixture 级的同名项 */
  options?: RawOptions;
  /** 用例级能力代号，**整体替换** fixture 级的 `use`（不是合并） */
  use?: string[];
  /**
   * 挂起原因。
   *
   * @remarks
   * 用来钉住**已知缺陷**：把期望写成「正确行为」，在依赖侧修好前挂起 ——
   * 缺陷既不会被遗忘（vitest 会报 skipped），也不会把 CI 染红。
   */
  skip?: string;
  /** 调试用：只跑本用例。记得改完后删掉 */
  only?: boolean;
  /** 期望输出，交给 `@isdk/match-ex` 匹配 */
  expect: Expectation;
}

export interface FixtureDecl {
  /** 一句话说明这个 fixture 在测什么；省略时取目录名 */
  description?: string;
  /** 待测文本文件名；省略时取 `doc.md` */
  doc?: string;
  /** fixture 级选项，被用例级覆盖 */
  options?: RawOptions;
  /** 需要注入的外部能力代号，如 `dmp` / `jieba` / `cjk` */
  use?: string[];
  /** 是否附加通用不变式校验（坐标契约等） */
  invariants?: boolean;
  /** 挂起整个 fixture 的原因 */
  skip?: string;
  /** 调试用：只跑本 fixture。记得改完后删掉 */
  only?: boolean;
  /** 一条或多条摘录用例 */
  cases: CaseDecl | CaseDecl[];
}

export interface LoadedCase {
  name: string;
  excerpt: string;
  options: RawOptions;
  /** 生效的能力代号 */
  use: string[];
  skip?: string;
  only: boolean;
  expect: Expectation;
}

export interface LoadedFixture {
  /** 目录名 */
  id: string;
  description: string;
  /** case.json 的绝对路径 —— 报错时定位用 */
  file: string;
  /** 待测文本 */
  raw: string;
  /** fixture 级选项 */
  baseOptions: RawOptions;
  /** 需要注入的能力代号 */
  use: string[];
  invariants: boolean;
  skip?: string;
  only: boolean;
  cases: LoadedCase[];
}

/** 排期结果：一个待执行的用例 + 它不执行的原因 */
export interface ScheduledCase {
  fixture: LoadedFixture;
  case: LoadedCase;
  /** 省略表示正常执行 */
  skipReason?: string;
}

class FixtureError extends Error {
  constructor(file: string, message: string) {
    super(`${basename(file)}: ${message}`);
  }
}

function readJson<T>(file: string): T {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T;
  } catch (e) {
    throw new FixtureError(file, `case.json 不是合法 JSON —— ${(e as Error).message}`);
  }
}

function mergeOptions(base: RawOptions, overrides: RawOptions | undefined): RawOptions {
  return overrides ? { ...base, ...overrides } : { ...base };
}

/**
 * 把 `cases` 统一成数组。
 *
 * 单对象写法 <=> 单元素数组，两者在 runner 眼里完全一致 ——
 * 这样 fixture 作者不必为了「只有一条摘录」而多包一层方括号。
 */
function normalizeCases(file: string, cases: CaseDecl | CaseDecl[] | undefined): CaseDecl[] {
  if (!cases) throw new FixtureError(file, '缺少 cases 字段');
  const list = Array.isArray(cases) ? cases : [cases];
  if (list.length === 0) throw new FixtureError(file, 'cases 不能为空数组');
  list.forEach((c, i) => {
    if (typeof c?.excerpt !== 'string' || c.excerpt.length === 0) {
      throw new FixtureError(file, `cases[${i}] 缺少 excerpt`);
    }
    if (!c.expect || typeof c.expect !== 'object') {
      throw new FixtureError(file, `cases[${i}] 缺少 expect`);
    }
  });
  return list;
}

function loadFixture(dir: string, id: string): LoadedFixture {
  const file = join(dir, 'case.json');
  const decl = readJson<FixtureDecl>(file);

  const docName = decl.doc ?? 'doc.md';
  const docFile = join(dir, docName);
  if (!existsSync(docFile)) {
    throw new FixtureError(file, `找不到待测文本 ${docName}`);
  }

  const use = [...(decl.use ?? [])];
  // 能默认就默认：.md 文档必然要摊平，不必每个 fixture 都重复写 use: ['markdown']。
  // 但 `matcher` 例外：它走高层入口，摊平器由入口自己装配 ——
  // fixture 再写 markdown 就变成显式注入，测的就不是零配置链路了。
  if (
    extname(docName) === '.md' &&
    !use.some((u) => u.startsWith('markdown')) &&
    !use.includes('matcher')
  ) {
    use.unshift('markdown');
  }

  const baseOptions = decl.options ?? {};
  const cases = normalizeCases(file, decl.cases).map((c) => ({
    name: c.name ?? c.excerpt,
    excerpt: c.excerpt,
    options: mergeOptions(baseOptions, c.options),
    use: c.use ?? use,
    skip: c.skip,
    only: c.only ?? false,
    expect: c.expect,
  }));

  return {
    id,
    description: decl.description ?? id,
    file,
    raw: readFileSync(docFile, 'utf8'),
    baseOptions,
    use,
    invariants: decl.invariants ?? true,
    skip: decl.skip,
    only: decl.only ?? false,
    cases,
  };
}

/**
 * 扫描 `test/fixtures/*`，按目录名排序 —— 保证测试输出的顺序稳定。
 *
 * `_` / `.` 开头的目录跳过，方便临时停用某个 fixture（改名为 `_xxx` 即可）。
 */
export function discoverFixtures(root = FIXTURES_DIR): LoadedFixture[] {
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .filter((name) => !name.startsWith('_') && !name.startsWith('.'))
    .filter((name) => statSync(join(root, name)).isDirectory())
    .sort()
    .map((name) => loadFixture(join(root, name), name));
}

/**
 * 按 `skip` / `only` 决定每个用例跑不跑。
 *
 * 不直接依赖 vitest 的 `.only` —— 它一旦出现在文件里就会影响整轮的过滤行为，
 * 而这里的规则（fixture 级 / 用例级、skip 优先）写清楚之后行为才可预测。
 *
 * 挂起的用例仍然会出现在报告里（vitest 记为 skipped），不会被悄悄丢掉。
 */
export function schedule(fixtures: readonly LoadedFixture[]): ScheduledCase[] {
  const onlyFixtures = fixtures.filter((f) => f.only && !f.skip);
  const out: ScheduledCase[] = [];

  const pushAll = (fx: LoadedFixture, reason: string) => {
    for (const c of fx.cases) out.push({ fixture: fx, case: c, skipReason: reason });
  };

  for (const fx of fixtures) {
    if (fx.skip) {
      pushAll(fx, fx.skip);
      continue;
    }
    if (onlyFixtures.length > 0 && !fx.only) {
      pushAll(fx, '本 fixture 未标记 only');
      continue;
    }
    const onlyCases = fx.cases.filter((c) => c.only && !c.skip);
    for (const c of fx.cases) {
      let reason = c.skip;
      if (!reason && onlyCases.length > 0 && !c.only) reason = '本用例未标记 only';
      out.push({ fixture: fx, case: c, skipReason: reason });
    }
  }
  return out;
}

/** 把 `{ regex, flags }` 转成 RegExp。JSON 里没法直接写字面量，这是唯一需要显式声明的地方 */
export function toRegExp(spec: unknown, at: string): RegExp {
  const s = spec as RegexSpec;
  if (!s || typeof s.regex !== 'string') {
    throw new Error(`${at}: 期望 { "regex": "...", "flags": "i" } 形式的正则声明，实际 ${JSON.stringify(spec)}`);
  }
  return new RegExp(s.regex, s.flags);
}

export function isRegexSpec(v: unknown): v is RegexSpec {
  return !!v && typeof v === 'object' && typeof (v as RegexSpec).regex === 'string';
}
