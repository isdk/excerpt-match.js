import { defineConfig } from 'tsup';

/**
 * 根配置**只用来做类型检查的工作区**，不产出构建产物。
 *
 * 各包在 `packages/*/tsup.config.ts` 里各自构建 ——
 * 这样每个包能独立发版、独立决定自己的格式与 external。
 */
export default defineConfig({
  // 无 entry：根不发版
  entry: [],
  dts: false,
});
