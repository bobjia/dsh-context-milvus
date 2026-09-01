# AGENTS.md — 语义代码搜索工具使用指南

本工程启用了 `dsh-context-milvus` 语义代码检索引擎。以下工具由 DSH 插件自动注册，模型应遵循本文件的规则调用。

## 可用工具

| 工具 | 作用 | 关键参数 |
|------|------|----------|
| `search_code` | 自然语言语义搜索代码，返回相关代码片段 | `query`(必填)、`topK`(默认5)、`path` |
| `index_code` | 索引/更新代码库 | `mode`(`full`/`incremental`)、`path` |
| `index_status` | 查看索引状态（文件数/代码块/最后索引时间） | `path` |
| `search_adr` | 语义搜索 ADR 决策记录，了解代码的"为什么" | `query`(必填)、`status`、`topK` |
| `search_adr_by_file` | 通过代码文件路径查找关联的 ADR 决策记录 | `file_path`(必填)、`status` |
| `create_adr` | 创建新的 ADR 决策记录 | `title`(必填)、`requirement`、`change_type` |
| `update_adr` | 更新已有 ADR 决策记录 | `adr_id`(必填)、`content`、`status` |
| `list_adrs` | 列出 ADR 决策记录目录 | `status`、`change_type`、`limit` |
| `load_constraints` | 加载 active ADR 的约束条件 | `adr_ids`、`format` |
| `check_adr_consistency` | 检查 ADR 与代码的一致性 | `file_path`、`fix` |

## 使用规则

1. **找代码优先用 `search_code`，不要 grep 或瞎读文件**

   当需要定位功能实现、回答“某功能在哪 / 怎么实现”这类问题时，先调用 `search_code` 做语义检索，拿到精准片段后再按需读取完整文件。不要为找代码反复 grep + 大批读文件，那会污染上下文、浪费 token。

2. **首次使用前先索引**

   若 `index_status` 显示“从未索引”（`lastIndexed` 为空），或仓库结构刚建，先用 `index_code mode=full` 建立索引，再开始搜索。

3. **代码变更后增量更新**

   用户改动了代码并需要基于最新代码回答时，先执行 `index_code`（默认 `incremental`，只重建变更文件），再搜索。

4. **多工作区自动适配**（无需手动传 `path`）

   三个工具会自动检测当前 DSH 工作区目录，无需手动传 `path` 参数。每个工作区使用独立的索引状态文件，互不干扰。如果确实需要跨工作区搜索，可以显式传 `path` 参数覆盖默认路径。

5. **`topK` 不要贪多**

   默认 5 个结果足够定位，仅当语义覆盖不足时才增大，避免把太多无关片段灌进上下文。

## 何时用 `full` vs `incremental`

- `incremental`（默认）：只索引新增/修改的文件，速度快，日常首选
- `full`：全量重建；在文件大范围重命名/移动目录、索引状态文件丢失、或怀疑索引脏了时使用

## ADR 决策记忆使用规则

ADR（Architecture Decision Record）决策记忆系统记录代码变更背后的设计原因，让模型不仅能读代码，还能理解"为什么"。

1. **修改代码前**，先调用 `search_adr_by_file` 确认该文件是否有 ADR 决策记录覆盖
2. **做出设计决策**（新功能/重构/架构变更/新依赖）时，使用 `create_adr` 记录决策原因
3. **修改了被 ADR 覆盖的代码**后，使用 `update_adr` 更新对应 ADR 的 code_anchors
4. **任务完成前**，调用 `check_adr_consistency` 确认一致性
5. **需要了解约束**时，使用 `load_constraints` 查看 active ADR 的约束条件