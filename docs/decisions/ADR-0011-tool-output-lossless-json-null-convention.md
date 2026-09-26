---
id: ADR-0011-tool-output-lossless-json-null-convention
type: decision-record
status: active
created: 2026-09-18
updated: 2026-09-26
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: packages/core/src/indexer.ts
    symbols:
      - getIndexStatus
  - file: packages/core/src/types.ts
    symbols:
      - IndexStatus
  - file: packages/core/src/adr-indexer.ts
    symbols:
      - getAdrIndexStatus
  - file: packages/dsh/src/plugins/dsh-context-milvus/tools.ts
  - file: packages/core/test/dsh-context-remdb.spec.ts
  - file: packages/dsh/test/test-all-tools.mjs
trigger:
  task_id: null
  requirement_summary: '未建立过索引的项目调用 index_status 时，core 在工作区从未索引时返回 { lastIndexed: undefined }，DSH 的 lossless-JSON 快照校验拒绝 undefined 属性并抛 ToolOutputError。'
  change_type: bugfix
related_decisions: []
auto_generated: false
---

# 工具边界输出必须是无损 JSON：lastIndexed 用 null 而非 undefined

> 本 frontmatter 于 2026-09-26 补写：该文件最初由 `create_adr` 以 `content` 传入正文产出，
> 而当时的 `AdrService.createAdr()` 会用 `content` 整文件覆盖模板，导致 frontmatter 丢失、
> 记录对 `list_adrs` / `search_adr` / `search_adr_by_file` / `load_constraints` 隐身。
> 产出侧的根因已由 ADR-0014 修复。

## 背景

未建立过索引的项目调用 `index_status` 时，DSH 报 `Error: tool "index_status" returned invalid output: values is not lossless JSON`。

## 根因

`getIndexStatus()`（packages/core/src/indexer.ts）在工作区从未索引时返回 `{ lastIndexed: undefined }`。DSH 工具层（dsh-tools `snapshotJsonValue()`，dsh-util-values）要求所有工具返回值必须是**无损 JSON**：`undefined` 属性在 JSON 往返中会丢键（`JSON.stringify({a: undefined})` → `{}`），snapshot 校验直接拒绝并抛 `ToolOutputError("value is not lossless JSON")`，harness 将其包装为 "returned invalid output: values is not lossless JSON"。

## 决策

`IndexStatus.lastIndexed` 类型由 `lastIndexed?: string` 改为 `lastIndexed: string | null`；未索引时返回 `null` 而非 `undefined`。

**为什么用 `null` 而不是省略键或空字符串：**
- `undefined` 会被 DSH/MCP 边界的 lossless-JSON 快照校验拒绝 —— 这是本 bug 的根因，绝不能再出现。
- `null` 是 JSON 原生的"无值"表示，键始终存在，调用方（DSH formatter `v.lastIndexed || '从未索引'`、codex result-format、MCP structuredContent）无需感知键可能存在/不存在两种情况。
- 空字符串 `''` 是 ADR 侧 `getAdrIndexStatus` 的历史惯例，但 `null` 语义更明确；两者都被 formatter 的 `|| '从未索引'` 兜底，不影响显示。

## 约束（隐含）

- **工具边界返回值绝不允许出现 `undefined` 属性值**（含嵌套对象/数组元素）。这条同时适用于 DSH `defineTool` 的 `execute` 返回值和 MCP `structuredContent`。写入/更新工具输出时优先用 `null`、省略展开（`...(x !== undefined ? {k: v} : {})`）或条件赋值。
- core 引擎是 DSH 与 codex 两个适配器的共享内核（SPEC/PLAN-codex-mcp-port 的单份内核约束）：边界契约修复必须落在 core，而不是在某个适配器里打补丁，否则会漂移。
- 修改 `IndexStatus` 公共类型时需同步检查 packages/dsh/test/public-surface.spec.ts（公共契约冻结测试）。
- **DSH `defineTool` 输出 schema 必须与 core 返回类型一致**：当 core 字段为 `T | null` 时，DSH schema 字段必须是 `oneOf: [{type: '<T>'}, {type: 'null'}]`。DSH 的 schema 子集不支持 `nullable` 关键字（仅支持 type / oneOf / properties / required / additionalProperties / items / enum / const 加上 description/title 注释），仅写 `type: '<T>'` 会被 `validateJsonSchemaValue` 以 `"value.X" must be a <T>` 拒绝。

## 被否决的反模式

- ❌ 在 DSH `tools.ts` 里给返回值补默认值而不修 core —— codex 适配器会带着同样的 bug。
- ❌ 用条件展开把 `lastIndexed` 键整个省略 —— 虽然也是无损 JSON，但让"键是否存在"成为调用方必须分支处理的第二种状态，不如恒存在的 `null` 键直白。

## code_anchors

- packages/core/src/indexer.ts (getIndexStatus)
- packages/core/src/types.ts (IndexStatus)
- packages/core/test/dsh-context-remdb.spec.ts (getIndexStatus describe)
- packages/dsh/src/plugins/dsh-context-milvus/tools.ts (index_status schema oneOf + formatter 兜底)
- packages/core/src/adr-indexer.ts (getAdrIndexStatus 既有 '' 惯例参照)
- packages/dsh/test/test-all-tools.mjs (未索引工作区断言对齐 null)
