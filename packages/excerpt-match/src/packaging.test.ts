/**
 * 发布契约测试。
 *
 * 为什么值得写测试：workspace 里 `main`/`exports` 指向 `dist/*.js`（与发布
 * 形态一致），少了 `exports` 声明就会在**用户侧**炸成
 * `ERR_PACKAGE_PATH_NOT_EXPORTED`，而这类错误靠人眼 review 守不住。
 *
 * 另一条被钉住的规则：**主包不再代售子包契约**。
 * 归一化、md 摊平、否定检测这些能力已经拆成独立子包，主入口只保留
 * 自己实现的 API 与这些 API 签名上的类型。文档里引用子包能力时，
 * 必须从 `@isdk/*` 子包导入。
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkgUrl = new URL('../package.json', import.meta.url);
const tsupUrl = new URL('../tsup.config.ts', import.meta.url);
const indexUrl = new URL('./index.ts', import.meta.url);
/** 中英文 README 都要守 —— 只改一边是文档漂移的常见来源 */
const readmeUrls = [new URL('../README.md', import.meta.url), new URL('../README.en.md', import.meta.url)];

const pkg = JSON.parse(readFileSync(pkgUrl, 'utf8')) as {
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, unknown> };
};
const tsupSrc = readFileSync(tsupUrl, 'utf8');
const indexSrc = readFileSync(indexUrl, 'utf8');
const readmes = readmeUrls.map((u) => ({ file: u.pathname.split('/').pop() ?? '', text: readFileSync(u, 'utf8') }));

/** 从 tsup.config.ts 里抽出 entry 的基名（`src/xxx.ts` → `xxx`） */
function entryNames(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/['"]src\/([A-Za-z0-9_-]+)\.ts['"]/g)) out.add(m[1]);
  return [...out];
}

const entries = entryNames(tsupSrc);

describe('构建入口', () => {
  it('包含主入口', () => {
    expect(entries).toContain('index');
  });
});

describe('★ exports 与构建入口一一对应', () => {
  it('每个 entry 都有 exports 声明（否则发布后解析不到）', () => {
    for (const name of entries) {
      const key = name === 'index' ? '.' : `./${name}`;
      expect(pkg.exports?.[key], `exports["${key}"]`).toBeDefined();
      expect(pkg.publishConfig?.exports?.[key], `publishConfig.exports["${key}"]`).toBeDefined();
    }
  });

  it('exports 里没有指向不存在入口的子路径', () => {
    for (const key of Object.keys(pkg.exports ?? {})) {
      const name = key === '.' ? 'index' : key.replace(/^\.\//, '');
      expect(entries, `exports["${key}"] 没有对应 entry`).toContain(name);
    }
  });
});

describe('★ 主入口的 exports 形态正确', () => {
  it('开发期即指向 dist，且与 publishConfig 完全一致', () => {
    const exp = pkg.exports?.['.'] as Record<string, string> | undefined;
    expect(exp).toBeDefined();
    expect(exp!.types).toContain('dist/index.d.ts');
    expect(exp!.import).toContain('dist/index.js');
    expect(exp!.require).toContain('dist/index.cjs');
    // 顶层 exports 是开发期真正生效的解析入口，必须与发布配置同步，
    // 否则「本地能跑、发布后炸」的漂移会在用户侧才暴露
    expect(exp).toEqual(pkg.publishConfig?.exports?.['.']);
  });

  it('发布期指向 dist，且同时给 import / require', () => {
    const pub = pkg.publishConfig?.exports?.['.'] as Record<string, string> | undefined;
    expect(pub).toBeDefined();
    expect(pub!.types).toContain('dist/index.d.ts');
    expect(pub!.import).toContain('dist/index.js');
    expect(pub!.require).toContain('dist/index.cjs');
  });
});

/**
 * 这些是**子包**的实现。主包拆包后不再代售它们 ——
 * 想用请直接装对应子包。
 */
const SUBPACKAGE_IMPLEMENTATIONS = [
  // @isdk/normalize-text
  'normalizeWithMap',
  'snapToGraphemeBoundary',
  'countGraphemes',
  'createCjkNumberParser',
  'CHINESE_NUMERAL_CHARS',
  // @isdk/whitespace-semantics
  'unicodeScriptOf',
  'canDropSpaceBetween',
  // @isdk/zh-negation
  'detectNegation',
  'negationsConflict',
  // @isdk/zh-particles
  'createGuardListParticleTagger',
  'createJiebaParticleTagger',
  'PARTICLE_TAGS',
  'PARTICLES',
  'SOLID_WORDS',
  // @isdk/md-flatten
  'createMdastFlattener',
  'createCachedFlattener',
  'regexFlattener',
  'trimMarkdownEdges',
  'expandToInlineMarkers',
  'deriveJoined',
  // @isdk/semantic-locate
  'splitSegments',
];

describe('★ 主包不再代售子包的实现', () => {
  it('主入口不导出子包的实现符号', () => {
    for (const name of SUBPACKAGE_IMPLEMENTATIONS) {
      expect(indexSrc, `主入口仍在导出 ${name}`).not.toMatch(new RegExp(`\\b${name}\\b`));
    }
  });

  it('只有一个入口（子路径已随拆包移除）', () => {
    expect(entries).toEqual(['index']);
  });
});

/** 子包能力 → 归属包名。文档示例必须从对应子包导入。 */
const OWNER: Record<string, string> = {
  normalizeWithMap: '@isdk/normalize-text',
  snapToGraphemeBoundary: '@isdk/normalize-text',
  createCjkNumberParser: '@isdk/normalize-text',
  stripGroupingSeparators: '@isdk/normalize-text',
  unicodeScriptOf: '@isdk/whitespace-semantics',
  canDropSpaceBetween: '@isdk/whitespace-semantics',
  detectNegation: '@isdk/zh-negation',
  createJiebaParticleTagger: '@isdk/zh-particles',
  createGuardListParticleTagger: '@isdk/zh-particles',
  createMdastFlattener: '@isdk/md-flatten',
  createCachedFlattener: '@isdk/md-flatten',
  regexFlattener: '@isdk/md-flatten',
  splitSegments: '@isdk/semantic-locate',
};

describe('★ 文档里的子包能力必须从子包导入', () => {
  const imports = readmes.flatMap(({ file, text }) =>
    [...text.matchAll(/import\s*(?:type\s*)?\{([^}]+)\}\s*from\s*'([^']+)'/g)].map((m) => ({
      file,
      names: m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0].trim()),
      from: m[2],
    }))
  );

  it('README 里存在可校验的 import 示例', () => {
    expect(imports.length).toBeGreaterThan(0);
  });

  for (const [name, owner] of Object.entries(OWNER)) {
    it(`★ ${name} 只能从 ${owner} 导入`, () => {
      for (const im of imports) {
        if (!im.names.includes(name)) continue;
        expect(im.from, `${im.file}: ${name} 却从 ${im.from} 导入`).toBe(owner);
      }
    });
  }
});

describe('★ 文档不再宣传已移除的主包子路径', () => {
  for (const { file, text } of readmes) {
    it(`${file} 不出现 excerpt-match/<子路径>`, () => {
      const documented = [...text.matchAll(/excerpt-match\/([A-Za-z0-9_-]+)/g)].map((m) => m[1]);
      expect(documented, `${file} 仍写到：${documented.join(', ')}`).toEqual([]);
    });
  }
});
