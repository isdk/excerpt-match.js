import { defineConfig } from 'tsup';
export default defineConfig({
  // 单入口。
  //
  // 曾经有 number / text / linguistics 等子路径，但它们只是把子包的契约
  // 从主包再导出一遍 —— 拆包之后主包不再代售子包契约，需要那些能力请直接
  // 装 `@isdk/normalize-text` / `@isdk/md-flatten` / … 子包。
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  target: 'es2022',
  /**
   * 可选依赖一律 external。
   *
   * 尤其 `@isdk/nlp-jieba`：它的 nodejs 版是运行时
   * `fs.readFileSync(__dirname + '/jieba_bg.wasm')` 加载二进制，
   * esbuild 打不进 bundle（.wasm 不是模块而是资源文件）。
   * 实测 bundle 后运行时报 ENOENT: jieba_bg.wasm。
   *
   * 注意：esbuild-plugin-wasm 解决不了这个问题 —— 它处理的是
   * `import wasm from './x.wasm'` 这种 ESM import 语句，
   * 对 readFileSync 无能为力，且只支持 esm 输出格式。
   */
  external: [
    'diff-match-patch',
    'diff-match-patch-es',
    'mdast-util-from-markdown',
    'mdast-util-gfm',
    'micromark-extension-gfm',
    'secondary-cache',
    'cjk-number',
    '@isdk/nlp-jieba',
  ],
});
