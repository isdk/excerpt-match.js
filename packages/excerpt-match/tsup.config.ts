import { defineConfig } from 'tsup';
export default defineConfig({
  // 多入口：主入口 + 若干子路径，便于按需引入（tree-shaking 更彻底，
  // 也避免「只想用中文数字解析却引入整个匹配器」）
  entry: [
    'src/index.ts',
    'src/number.ts',
    'src/text.ts',
    'src/linguistics.ts',
  ],
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
