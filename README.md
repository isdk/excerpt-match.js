# excerpt-match workspace

[English](./README.en.md) | 中文

在 **markdown 正文中定位摘录出处**，返回精确的源码坐标（`index` / `length`）。

本仓库是 **pnpm workspace 根目录**，本身**不发布**；真正的包都在 `packages/` 下。

## 快速开始

```bash
pnpm install

# 各包独立测试（与 build 一致，根目录只做递归调度）
pnpm test                              # pnpm -r，依次跑各包的 test
pnpm --filter @isdk/zh-negation test   # 只跑某一个包

pnpm run typecheck
pnpm run build
```

**测试组织**：`vitest.workspace.ts` 把 9 个包聚合成**一次运行**，
最后给一行汇总（`Test Files 25 passed / Tests 349 passed`）。
也能单跑：`pnpm --filter @isdk/zh-negation test`。

**没有用任何路径别名** —— pnpm workspace 已经把 `@isdk/*` 软链到
`packages/*`，各包 `package.json` 的 `main`/`exports` 在**开发期直接指向
`src/index.ts`**，发布时由 `publishConfig` 切到 `dist`。所以测试不依赖构建产物，
`tsconfig.json` 里也没有 `paths`。

## 发布

版本与 CHANGELOG 由
[commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version)
管理（`-s`：对 release 提交与 tag 做 GPG 签名）：

```bash
# 全量：所有子包先 clean → build → release（按依赖拓扑序），最后处理根目录
pnpm release

# 单发某一个包：只 bump 版本 / 生成 CHANGELOG / 打 tag
pnpm --filter @isdk/md-flatten release

# 查看某个包的全部发布 tag
git tag -l "@isdk/md-flatten/*"
```

- **Tag 前缀即包名**：子包 tag 形如 `@isdk/md-flatten/v1.0.1`，互不冲突；根目录为私有包，tag 用默认 `v` 前缀（如 `v1.0.1`）代表工作区整体版本，与子包 tag 也不冲突
- **串行提交**：子包 release 阶段以 `--workspace-concurrency=1` 执行，避免并发 `git commit` 撞 `.git/index.lock`
- **幂等**：没有新提交的包自动跳过（不改版本、不打 tag），全量重跑安全

## 包一览

| 包 | 职责 |
|---|---|
| [`@isdk/excerpt-match`](./packages/excerpt-match) | **主包**：分层定位与编排（T0–T4） |
| [`@isdk/normalize-text`](./packages/normalize-text) | 归一化 + 保留原文坐标映射 |
| [`@isdk/md-flatten`](./packages/md-flatten) | md 源码 ↔ 渲染后文本双向坐标映射 |
| [`@isdk/approx-text-match`](./packages/approx-text-match) | 近似子串定位（连续区间 + 相似度） |
| [`@isdk/semantic-locate`](./packages/semantic-locate) | 两阶段语义定位：召回 → 段内对齐 |
| [`@isdk/whitespace-semantics`](./packages/whitespace-semantics) | 脚本感知空白：韩文/泰文空格不能删 |
| [`@isdk/identifier-variants`](./packages/identifier-variants) | `TensorFlow` ≡ `tensor_flow` |
| [`@isdk/zh-negation`](./packages/zh-negation) | 中文否定检测（词边界感知） |
| [`@isdk/zh-particles`](./packages/zh-particles) | 的/地/得：助词 vs 实词 |

每个子包都有自己的 `README.md` / `README.en.md`。

## 文档

- 包划分与职责：[PACKAGES.md](./PACKAGES.md) / [PACKAGES.en.md](./PACKAGES.en.md)
- 架构与坐标系：[ARCHITECTURE.md](./ARCHITECTURE.md) / [ARCHITECTURE.en.md](./ARCHITECTURE.en.md)
- 主包用法：[packages/excerpt-match/README.md](./packages/excerpt-match/README.md)

## 约定

- KISS
- 职责内聚，重视复用
- 不重复发明轮子
- **测试与被测文件同目录**：`src/xxx.ts` ↔ `src/xxx.test.ts`
- `index.ts` 只做导出，不放实现
- 源码注释用 TSDoc，重点写「为什么」
