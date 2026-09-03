---
id: ADR-0005-tool-output-schema-validation-fixes
type: decision-record
status: active
created: 2026-09-03T03:30:24.877Z
updated: 2026-09-03T03:30:51.573Z
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: src/plugins/dsh-context-milvus/tools.ts
    symbols:
      - find_callers
      - registerTools
    lines: [412, 442]
  - file: src/plugins/dsh-context-milvus/adr-tools.ts
    symbols:
      - index_specs
      - registerAdrTools
    lines: [490, 506]
trigger:
  task_id: null
  requirement_summary: "`find_callers` forward 方向返回的 chunk 包含 `references` 字段但 output schema 未声明，`index_specs` dry-run 返回的 `detectedRefs` 包含 `lines` 字段但 output schema 未声明，导致 DSH 输出校验拒绝这两个工具。"
  change_type: bugfix
related_decisions: []
auto_generated: false
---
## 决策目标

修复两个 DSH 工具（`find_callers`、`index_specs`）的 output schema 与真实返回值不一致的问题。所有 DSH 工具通过 `defineTool()` 声明 output schema，返回对象在交给模型前会经过严格校验（`additionalProperties: false`）；schema 漏声明真实返回字段会导致整个工具调用被 DSH 运行时拒绝，报 `"value...." is not a declared property`。

- `find_callers` direction=forward：`findBySymbol` 返回带 `references: string[]` 的 chunk（tools.ts execute 内 `queryByName` 结果映射），但 output schema 的 `chunks.items.properties` 未声明 `references` → forward 方向每次调用都失败。
- `index_specs` dry_run：`preview[].detectedRefs[]` 实际携带 `DetectedRef.lines: [number, number]`（adr-anchor-generator.ts:10-14 定义），但 output schema 只声明 `file`/`symbols` → 任何含锚点检测的 dry-run 都失败。

## 约束条件

- DSH 工具 output schema 必须与 execute 实际返回结构完全一致（含所有可选字段），否则运行时校验拒绝
- 修复只应做 schema 声明补齐，不得改变 execute 返回值的语义或结构
- backward 方向的 chunk 没有 `references` 字段（可选字段），schema 补齐后必须保持向后兼容（字段声明为可缺省即可，JSON Schema 中非 required 即可选）

## 候选方案与权衡

### 方案A：改动 execute 返回值，去掉多余字段
- **描述**：从 forward 返回的 chunk 中剥离 `references`，或在 render 前过滤
- **优点**：schema 不用动
- **缺点**：`references` 是 forward 方向的核心信息（列出该函数引用了谁），去掉会丢失 trace_call_chain 依赖的数据；过滤逻辑增加每调用开销
- **放弃原因**：治标不治本，破坏 forward 方向功能语义

### 方案B：在 output schema 中补齐缺失字段声明（✅ 选用）
- **描述**：`find_callers` 的 `chunks.items.properties` 增加 `references: { type: 'array', items: { type: 'string' } }`；`index_specs` 的 `preview[].detectedRefs[].properties` 增加 `lines: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 }`
- **优点**：最小侵入、schema 与类型定义（RelationChunk.references、DetectedRef.lines）对齐；不改变任何运行时行为；后续类型演进时 schema 即文档
- **缺点**：无（schema 冗余字段风险由 `additionalProperties: false` 反向控制，已排查无其他漏声明字段）
- **选择原因**：schema 声明本质是对类型定义的镜像，类型已存在、只是 schema 没跟上

## 关键设计细节与隐性约束

### 隐性约束1：schema 必须镜像 execute 的全部返回字段
- **内容**：工具 output schema 的每个属性都要能在 execute 返回对象中找到对应字段，反之亦然；新增可选返回字段时必须同步补 schema
- **原因**：`defineTool` 的 output validation 使用 `additionalProperties: false` 严格模式
- **如果破坏会怎样**：工具调用直接报 schema 错误，表现为"工具坏了"但根因是 schema 与代码脱节

### 隐性约束2：schema 缺省字段即可选，不影响老调用方
- **内容**：JSON Schema 中未标记 required 的属性为可选；backward chunk 不返回 references 是合法的
- **原因**：backward/forward 共用同一 output schema
- **如果破坏会怎样**：若把 references 设为 required，backward 方向会全部校验失败

## 被否决的模式/反模式

- ❌ 在 execute 返回前剥掉 schema 未声明的字段来"绕过"校验 —— 掩盖 schema 与代码脱节的根因，且破坏功能数据
- ❌ 关闭或放宽 DSH 工具的 output 校验（如去掉 additionalProperties: false）—— 削弱所有工具的契约保障

## 相关测试

- `test/adr-tools.spec.ts` + `test/adr-indexer.spec.ts`：ADR 工具 schema 修改后 33 个用例全绿，确认 index_specs/create_adr/update_adr 等无回归
- `npm run build`（tsc）：类型检查通过，确认 schema 对象字面量类型无误

## 变更边界

- 新增任何带结构化返回的工具参数/字段时，重新 review 其 output schema 与 execute 返回结构是否一致
- 若 `find_callers`/`index_specs` 返回结构后续演进（字段改名/删除），需同步更新本 ADR code_anchors 指向的两个 schema
