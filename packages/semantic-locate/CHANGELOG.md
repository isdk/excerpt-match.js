# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## [0.2.0](///compare/@isdk/semantic-locate/0.1.1...@isdk/semantic-locate/0.2.0) (2026-09-29)

### ⚠ BREAKING CHANGES

* **excerpt-match:** createExcerptMatcher 返回 Promise<ExcerptMatcher>；
  default* 装配函数（defaultMarkdownFlattener / defaultFuzzyFallback /
  defaultCjkNumberParser / defaultParticleTagger）返回 Promise
* **excerpt-match:** ellipsis 不再接受模式数组，改为 boolean；
  allowSegmented 移除；PROSE_ELLIPSIS / EllipsisPattern 导出移除

### Features

* **bitap:** 支持多命中，新增 maxMatches / minScore 0e47a49
* **excerpt-match:** 集成测试支持 matcher 能力代号，新增毒化种子 fixture 3bf6ad2
* **excerpt-match:** 默认装配纯 ESM 化，动态 import 替代 createRequire，新增浏览器打包测试 8bcbef1
* **excerpt-match:** 省略约定固化为协议，ellipsis 改为 boolean 开关 9a3ff46
* **excerpt-match:** 新增 implicitEllipsis，识别省略中段却不带约定记号的摘要 7de17a2
* **excerpt-match:** T2 锚点守卫按词而非按字符判定 f2c8459

### Bug Fixes

* **adapters:** 修正放宽重试抢跑与 dmp 实例状态泄漏 270b27d
* **approx-text-match:** bitap 定位不到时放宽重试，pickSeed 跳过毒化种子 4ab6b0e
* **excerpt-match:** 修复空格分词语言省略标记两侧的占位符争抢 c016e29

## 0.1.1 (2026-09-21)

### Features

* **excerpt-match:** 高层入口零配置化，excerptVerifier 更名 excerptMatcher 88b7e56
* **excerpt-match:** 新增摘录校验器 excerptVerifier，命中即返回 md 原文 c762a14
* **normalize-text:** ignorePunctuation 细粒度化，并修边缘占位符不对称 e9adf5c

### Bug Fixes

* 修 T4 坐标/选项脱钩与 topK 缺陷；主包停止代售子包契约 3546952
* **excerpt-match:** 省略表达不再被 ignorePunctuation 吞掉 bf6b53f
* **excerpt-match:** punctFolded 边缘标点扩展补齐页面侧，并夹回块边界 709ca85
* **md-flatten:** 修源码坐标映射被转义/实体/代理对击穿的三处缺陷 489a430, references #39 #x27
* **md-flatten:** inlineCode 必须登记为行内构造，span 才能补齐反引号 925e81d
* **packages:** 顶层 main/exports 改为指向 dist，开发与发布形态一致 338f635
