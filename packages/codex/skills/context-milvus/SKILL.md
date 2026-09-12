---
name: context-milvus
description: Use when the user asks where a feature is implemented, how code works, or wants impact analysis before changing a symbol; also use before large refactors in repositories indexed in Milvus. Prefer this semantic search over broad grep over the whole repository.
---

# Context Milvus code search

## When to use

- 用户问“某功能在哪实现 / 怎么实现的” → 先 `search_code`，不要先全仓库 grep。
- 修改函数/变量/类之前 → 先 `find_callers` 做影响分析。
- 需要理解上下游调用关系 → `trace_call_chain`。

## Workflow

1. 首次使用先调用 `index_status`。若返回“从未索引”，调用 `index_code`（大仓库用 `mode: "full"`）。
2. 之后用 `search_code` 做自然语言检索，`topK` 保持 5 左右。
3. 代码变更后调用 `index_code`（默认增量）。
4. 多工作区场景显式传绝对路径 `path`。

## Rules

- 不要用 grep 全仓库搜索来回答“功能在哪”这类问题。
- 搜索结果里的文件路径是绝对路径，读取源码用 Codex 的读文件工具。
- 如果 `find_callers` / `trace_call_chain` 返回“import map 未加载”警告，先运行 `index_code` 再重试以启用精确解析。
