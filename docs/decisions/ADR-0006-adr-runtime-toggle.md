---
id: ADR-0006-adr-runtime-toggle
type: decision-record
status: active
created: 2026-09-03
updated: 2026-09-03
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: src/plugins/dsh-context-milvus/index.ts
    symbols:
      - toggleAdr
      - apply
    lines: [1, 260]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/adr-tools.ts
    symbols:
      - registerAdrTools
    lines: [1, 588]
    git_commit: ''
  - file: src/plugins/dsh-context-milvus/constraint-injector.ts
    symbols:
      - setupConstraintInjection
    lines: [1, 228]
    git_commit: ''
trigger:
  task_id: null
  requirement_summary: "ADR 开关需要在配置界面可以运行时动态切换，无需重载插件"
  change_type: architecture
related_decisions: []
auto_generated: false
---

## 决策目标

ADR 功能的启用/禁用开关 `adrEnabled` 之前只在插件启动时检查一次，在 Settings 界面修改后需要重载插件才生效。现改为运行时动态切换。

## 约束条件

- 用户在 Settings → Plugins → dsh-context-milvus 中切换 `adrEnabled` 后，ADR 工具和约束注入应立即生效或失效
- 切换不应导致插件崩溃或产生未定义行为
- 启动时若 `adrEnabled=true`，行为与之前完全一致

## 候选方案与权衡

### 方案A：仅在工具执行时检查 adrEnabled（✅ 选用）
- 启动时始终注册所有 ADR 工具和约束注入钩子
- 每个工具执行时检查 `adrEnabled`，若关闭则返回错误信息
- 约束注入钩子也检查该标志
- **优点**：实现最简单，无需处理注册/注销
- **缺点**：ADR 工具始终在工具列表中可见，即使用户未启用 ADR

### 方案B：利用 DSH 框架的 disposer 机制动态注册/注销（✅ 选用）
- 启动时始终创建 ADR 服务（轻量），但按 `adrEnabled` 状态动态注册/注销 ADR 工具与注入钩子
- 利用 DSH API 返回的 disposer 函数：`ctx.tools.register()` 返回 `() => void`，`systemPrompt.section()` 返回 `() => void`，`ctx.on()` 返回 disposer
- 在 `installSettingsSection` 的 `onChange` 回调中检测 `adrEnabled` 变化，调用 disposer 进行增量切换
- **优点**：ADR 关闭时工具列表干净，无多余工具；遵循 DSH 框架的设计模式
- **缺点**：实现稍复杂，需要妥善管理 disposer 的生命周期

方案B 被选用，因为它提供了更干净的 UX。

## 技术实现

### 改动文件

1. **`adr-tools.ts` — `registerAdrTools()`**
   - 删除内部 `if (!config.adrEnabled) return` 守卫（由调用方控制）
   - 收集每个 `ctx.tools.register()` 返回的 disposer
   - 返回 `(() => void)[]`（disposer 数组）

2. **`constraint-injector.ts` — `setupConstraintInjection()`**
   - 删除内部 `adrEnabled` 守卫
   - 收集 `systemPrompt.section()`、`systemPrompt.context()`、`ctx.on('agent/pre-step')`、`ctx.on('tools/result')` 返回的 disposer
   - 返回一个组合 disposer 函数

3. **`index.ts` — `apply()`**
   - ADR 服务（`AdrService`、`AdrAnchorIndex`、`HashTracker`）始终创建，不再依赖 `adrEnabled` 开关
   - `adrOptions` 始终传给 `registerTools()`（工具内部已按执行时的 `config.adrEnabled` 判断是否做 ADR 操作）
   - 新增 `toggleAdr()` 函数，根据 `adrEnabled` 状态动态注册/注销 ADR 工具和约束注入
   - 在 `installSettingsSection` 的 `onChange` 回调中调用 `toggleAdr()`

### 安全性

- DSH 同层不允许注册重名工具。切换 off→on 前必须先调用 disposer 注销，再重新注册
- `onChange` 回调同步执行注册/注销，工具执行时读取最新 config，无竞态
- 主工具（`index_code`/`index_status`）按 `effectiveConfig.adrEnabled` 判断 ADR 操作（现有逻辑），动态开关后行为正确

## 被否决的反模式

- ❌ 在工具执行函数中检查 `adrEnabled` 并返回错误信息：工具列表仍然可见，用户体验差
- ❌ 重载插件来应用配置变更：不符合"运行时动态切换"的需求
- ❌ 使用全局变量跟踪状态而不使用 disposer：可能导致内存泄漏和注册/注销不一致