import { defineWorkspace } from 'vitest/config';

/**
 * vitest workspace —— 一个命令跑全部包，并给出**汇总的**总数。
 *
 * @remarks
 * 为什么用它而不是 `pnpm -r run test`：
 * 后者每个包各跑一次，输出是 9 段独立的 "Test Files / Tests"，
 * 得自己加起来才知道总数、才知道有没有全绿。
 *
 * workspace 模式把 9 个包聚合成**一次运行**，最后给一行汇总：
 *
 * ```
 *  Test Files  19 passed (19)
 *       Tests  253 passed (253)
 * ```
 *
 * 单跑某个包仍可以：`pnpm --filter @isdk/zh-negation test`
 * （那里 `vitest run` 只扫本包）。
 */
export default defineWorkspace(['packages/*']);
