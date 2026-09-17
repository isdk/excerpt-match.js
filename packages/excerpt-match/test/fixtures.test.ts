/**
 * fixture 驱动的集成测试入口。
 *
 * 这个文件里**没有**任何断言逻辑 —— 它只负责把 `test/fixtures/*` 摊平成 vitest 的
 * describe/it 树。断言在 runner 里统一走 `@isdk/match-ex` 的期望值引擎。
 *
 * 所以「加一个用例」= 在 fixtures 下加一个目录，不需要碰这里。
 */

import { describe, it } from 'vitest';
import { discoverFixtures, schedule, type LoadedFixture } from './fixture';
import { formatFailures, runCase } from './runner';

const plan = schedule(discoverFixtures());

/** 按 fixture 分组，保持 case.json 里的声明顺序 */
const groups = new Map<LoadedFixture, typeof plan>();
for (const item of plan) {
  const list = groups.get(item.fixture);
  if (list) list.push(item);
  else groups.set(item.fixture, [item]);
}

describe('集成测试（fixture 驱动）', () => {
  it('至少有一个 fixture', () => {
    if (groups.size === 0) {
      throw new Error('test/fixtures 下没有任何 fixture 目录');
    }
  });

  for (const [fx, items] of groups) {
    describe(fx.description, () => {
      for (const { case: c, skipReason } of items) {
        const run = async () => {
          const { failures } = await runCase(fx, c);
          if (failures.length > 0) {
            throw new Error(`\n${formatFailures(fx, c, failures)}\n`);
          }
        };
        // 钉住已知缺陷：跳过而不是删掉，缺陷修好后把 skip 字段删掉即恢复
        if (skipReason) it.skip(`${c.name}（挂起：${skipReason}）`, run);
        else it(c.name, run);
      }
    });
  }
});
