---
id: ADR-0003-constraint-reinjection
type: decision-record
status: active
created: 2026-09-01
updated: 2026-09-01
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: src/plugins/dsh-context-milvus/constraint-injector.ts
    symbols:
      - setupConstraintInjection
      - refreshConstraintCache
      - createUserMessage
    lines: [1, 188]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/adr-tools.ts
    symbols:
      - load_constraints
    lines: [245, 281]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/config.ts
    symbols:
      - adrConstraintReinjectEvery
    lines: [54, 54]
    git_commit: ''
trigger:
  task_id: null
  requirement_summary: 约束需要注入系统提示并在 agent 长任务执行期间周期性重注入，防止约束被遗忘
  change_type: new_feature
related_decisions:
  - ADR-0001-milvus-collection-separation
  - ADR-0002-code-anchors-reverse-index
auto_generated: false
---

## 决策目标

将 ADR 决策记忆系统的约束条件注入到 agent 的系统提示中，并在长任务执行期间通过 `agent/pre-step` hook 周期性重注入，确保模型始终记得相关约束和隐性约束，不会在长上下文任务中被遗忘。

## 约束条件

- 约束注入必须使用 `ctx.systemPrompt.section()` 或 `ctx.systemPrompt.context()`（同步 provider）
- 重注入的频率由 `adrConstraintReinjectEvery` 配置（步数间隔，0=禁用）
- 不能修改用户消息，只能通过 `createUserMessage` 注入新的用户消息
- `tools/result` hook 只应关注 `write` 和 `edit` 工具（文件修改），不应在 `read` 时误报

## 候选方案与权衡

### 方案A：仅在系统提示中注入一次（❌ 放弃）
- **描述**：只把约束注入系统提示一次，不进行周期性重注入
- **优点**：实现简单
- **缺点**：长任务中约束会被后续对话内容稀释遗忘，尤其是显式约束和隐性约束，模型可能在执行后期违反约束
- **放弃原因**：无法满足"长任务期间保持约束"的核心需求

### 方案B：pre-step hook 周期性重注入（✅ 选用）
- **描述**：`agent/pre-step` hook 每 N 步（`adrConstraintReinjectEvery`，默认 5）异步刷新约束缓存，并通过 `createUserMessage` 注入约束文本到消息列表。同时 `tools/result` hook 检测文件修改（write/edit），产生待处理警告，在下一个 pre-step 注入
- **优点**：约束长期保持有效，文件修改警告及时反馈，实现简单且高效（同步 provider + 异步缓存刷新）
- **缺点**：需要在 lifecycle hook 中小心处理框架 API 兼容性
- **选择原因**：pre-step hook 在每步开始前执行，是注入约束的最佳时机；异步刷新避免阻塞正常流程

### 方案C：每次系统提示 provider 调用时实时查询（❌ 放弃）
- **描述**：`systemPrompt.context()` provider 每次调用时都实时查询 Milvus 获取约束
- **优点**：数据始终最新
- **缺点**：context() 必须同步，而 Milvus 查询是异步的；每次查询产生大量 I/O
- **放弃原因**：框架约束不允许同步 provider 中做异步查询，必须用内存缓存

## 关键设计细节与隐性约束

### 隐性约束1：`context()` provider 必须同步，用内存缓存
- **内容**：`ctx.systemPrompt.context()` 是同步函数，不能直接调用异步的 Milvus 查询。因此采用双通道：`context()` 返回内存缓存（同步、快），`agent/pre-step` hook 中异步刷新缓存（每 N 步）
- **原因**：DSH 框架的系统提示 provider 是同步接口，异步查询无法直接使用
- **如果破坏会怎样**：如果直接传入 async 函数会破坏框架契约，导致系统提示不渲染或抛错

### 隐性约束2：`createUserMessage` 从 `@deepseek-ai/dsh-llm` 导入
- **内容**：注入消息必须使用 `createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-context-milvus' } })` 格式
- **原因**：该工具是 DSH 框架提供的标准用户消息构造器，确保消息格式与框架兼容
- **如果破坏会怎样**：消息格式不符会导致 agent 无法解析或插件身份标识丢失

### 隐性约束3：`tools/result` hook 不监听 `read`
- **内容**：`FILE_TOOL_NAMES` 只包含 `write` 和 `edit`。读取文件不是修改，不应触发"你修改了文件"警告
- **原因**：避免误报干扰模型判断，浪费上下文
- **如果破坏会怎样**：模型每读一个被 ADR 覆盖的文件都会收到"你修改了文件"的假警告，混淆"已修改"与"已读取"状态

## 被否决的模式/反模式

- ❌ 仅在系统提示注入一次 —— 长任务中约束被遗忘
- ❌ 同步 provider 中直接异步查询 —— 违反框架契约

## 相关测试

- test/constraint-injector.spec.ts: 注册逻辑、pre-step hook 缓存刷新、消息注入、read 不告警、edit 告警

## 变更边界

- 当 DSH 框架的 systemPrompt API 变更时，需要更新注入方式
- 当需要支持更复杂的约束条件（如按文件动态过滤）时，扩展 pre-step 刷新逻辑