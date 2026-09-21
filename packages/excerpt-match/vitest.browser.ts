import { defineConfig } from 'vitest/config';

/**
 * 浏览器档配置 —— 与主 `vitest`（Node 档）分开：
 *
 * ```bash
 * pnpm exec vitest run --config vitest.browser.ts
 * # 或 npm run test:browser
 * ```
 *
 * ## 环境要求
 *
 * - `@vitest/browser@1.6.1` + `playwright-core` + `@playwright/browser-chromium`
 *   （已在本包 devDependencies；引擎二进制由 postinstall 下载到
 *   `~/.cache/ms-playwright`，需 `allowBuilds` 放行，见根 `pnpm-workspace.yaml`）
 * - 或本机已装 Chrome：`channel: 'chrome'` 直接复用，无需 playwright 引擎。
 *   两者都没有时测试文件按 `describe.skipIf` 跳过，不误伤 `npm test`。
 *
 * ## 为什么用 playwright provider 而不是 `browser.provider: 'none'`
 *
 * none 只是无头浏览器占位（依赖全局 playwright 安装），playwright provider
 * 用系统 Chrome 即可，装包最小。CI 无 Chrome 时靠跳过条件兜底。
 *
 * ## 浏览器档只跑打包测试
 *
 * `include` 收窄到 `browserPackaging`：其余测试是 Node 工程链路的单元/属性
 * 测试（fixture 文件读取、fast-check 等），不属于「包能否在浏览器打包」的契约。
 */
export default defineConfig({
  // jieba 的 web 构建用 `new URL('jieba_bg.wasm', import.meta.url)` 运行时拉取
  // wasm —— 预打包（optimizeDeps）会把模块重写到 .vite/deps，相对路径就 404 了。
  // 必须排除，让 vite 按真实文件路径伺服模块与 wasm（浏览器档顶层配置，
  // browser 模式起的是 vite dev server，读的是这里而不是 test.optimizeDeps）。
  optimizeDeps: { exclude: ['@isdk/nlp-jieba'] },
  test: {
    include: ['src/browserPackaging.test.ts'],
    browser: {
      enabled: true,
      name: 'chromium',
      headless: true,
      provider: 'playwright',
      providerOptions: {
        // 优先本机 Chrome（无引擎下载）；没有时 playwright 会退回
        // @playwright/browser-chromium 下载的 chromium-1161。
        // 注意 v1.6.1 的选项名是 launch（新版才是 launchOptions）。
        launch: { channel: 'chrome' },
      },
      // 浏览器档不与 Node 档抢并行资源（两个 chrome 实例没意义）
      fileParallelism: false,
    },
  },
});
