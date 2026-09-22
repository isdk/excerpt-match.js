import { defineConfig } from 'vitest/config';

/**
 * Node 档默认配置（`pnpm test` / `vitest run`）。
 *
 * ## 浏览器测试文件名约定
 *
 * 只在浏览器里跑的测试以 `*.browser.test.ts` 命名，这里**整体排除**：
 * 浏览器档另用 `vitest.browser.ts`（真实 Chrome + playwright provider）。
 *
 * 排除而不是靠 `describe.skipIf(!inBrowser)` 自我跳过，是为了让 Node 档
 * 的测试结果干净 —— 被跳过的测试会出现在「skipped」里，像是漏配了环境；
 * 按文件名分流后，Node 档要么全过、要么有真失败。
 */
export default defineConfig({
  test: {
    exclude: ['**/*.browser.test.ts', '**/node_modules/**', '**/dist/**'],
  },
});
