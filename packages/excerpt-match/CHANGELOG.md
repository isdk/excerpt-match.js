# Changelog

All notable changes to this project will be documented in this file. See [commit-and-tag-version](https://github.com/absolute-version/commit-and-tag-version) for commit guidelines.

## 1.1.0 (2026-09-21)

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
