---
id: ADR-0007-adr-config-panel-switch
type: decision-record
status: active
created: 2026-09-04T23:54:01.173Z
updated: 2026-09-04T23:54:37.180Z
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - client/client.js
trigger:
  task_id: null
  requirement_summary: "用户报告：配置面板（Settings → Plugins → dsh-context-milvus）中没有配置 ADR 的开关。虽然服务器端 Config schema（index.ts）定义了 adrEnabled/adrRoot/adrCollection/adrConstraintReinjectEvery/adrSystemPrompt 五个字段，且 installSettingsSection + toggleAdr() 已支持运行时开关，但客户端自定义渲染组件 MilvusConfigCard（client/client.js）手动罗列渲染字段时遗漏了全部 ADR 字段，导致 GUI 上无法看到和编辑 ADR 配置。"
  change_type: bugfix
related_decisions: []
auto_generated: false
---
## 决策目标

为 dsh-context-milvus 插件配置面板（Settings → Plugins → dsh-context-milvus）添加 ADR 决策记忆配置开关及相关字段。

## 问题背景

dsh-context-milvus 插件支持 ADR（Architecture Decision Record）决策记忆功能，服务端 `Config` schema（index.ts）已定义以下配置字段：
- `adrEnabled` (boolean) — 启用/禁用 ADR 决策记忆
- `adrRoot` (string) — ADR 目录路径（相对 indexRoot）
- `adrCollection` (string) — Milvus ADR 向量集合名称
- `adrConstraintReinjectEvery` (number) — 约束重注入步数间隔
- `adrSystemPrompt` (string) — 自定义 ADR 系统提示段落

但客户端配置面板使用自定义 React 组件 `MilvusConfigCard`（client/client.js）手动渲染字段，该组件遗漏了所有 ADR 字段，导致用户无法在 GUI 上看到或编辑 ADR 配置。

## 约束条件

- 客户端组件必须保持与后端 `Config` schema 字段定义一致
- 新增字段需支持 boolean（adrEnabled）、text（adrRoot/adrCollection/adrSystemPrompt）、number（adrConstraintReinjectEvery）三种类型
- adrSystemPrompt 应作为 textarea 多行输入框渲染（与后端 .role('textarea') 一致）
- 支持中/英双语本地化文案
- 必须注册到 fieldIds（用于构建表单状态）、fieldTypes（用于保存时的类型转换）和 fields 渲染数组

## 候选方案与权衡

### 方案A：替换为自动生成表单（✅ 不选用）
- **描述**：放弃自定义 MilvusConfigCard 组件，改用 DSH 根据 Config schema 自动生成的表单
- **优点**：无需手动维护字段列表，新增字段自动出现
- **缺点**：需改动较大的架构，当前自定义组件提供了更好的 UI 控制（如字段分组、展开折叠、boolean/textarea 特殊渲染）
- **放弃原因**：当前架构已深度使用自定义组件，且提供了更好的用户体验；仅需补全字段即可

### 方案B：在自定义组件中补全 ADR 字段（✅ 选用）
- **描述**：在 MilvusConfigCard 的 fields 渲染数组、fieldTypes 类型映射、fieldIds 状态字段列表、以及本地化字典中分别添加 ADR 相关字段
- **优点**：改动最小（仅 client/client.js），不涉及架构变更，与现有模式完全一致
- **缺点**：仍需手动维护，新增字段时容易遗漏
- **选择原因**：与现有 UI 模式一致，改动收敛，风险最小

## 关键设计细节与隐性约束

### 隐性约束1：字段渲染类型标记
- **内容**：字段定义通过 `boolean: true` 和 `textarea: true` 标记来路由到不同的渲染组件（BooleanField / TextareaField / ValueField）
- **原因**：MilvusConfigCard 的 fields.map() 渲染逻辑根据这些标记分发到不同的 UI 组件
- **如果破坏会怎样**：adrEnabled 会渲染为普通文本输入框而非复选框，adrSystemPrompt 会渲染为单行输入框而非多行文本框

### 隐性约束2：fieldTypes 类型映射必须完整
- **内容**：fieldTypes 映射定义了保存时从字符串到实际类型的转换规则（boolean→布尔值，number→数字，string→字符串）
- **原因**：save() 函数通过 toTypedValue() 使用此映射进行类型转换后写入 settings scope
- **如果破坏会怎样**：保存时 adrEnabled 会存为字符串 "true"/"false" 而非布尔值，导致后端 getConfig() 无法正确识别

### 隐性约束3：fieldIds 列表必须覆盖所有渲染字段
- **内容**：buildState() 遍历 fieldIds 列表从 settings scope 读取当前值和基础值，构建表单状态
- **原因**：未在 fieldIds 中注册的字段不会出现在 state 对象中，渲染时 state[field.id] 返回 undefined
- **如果破坏会怎样**：ADR 字段在组件中虽然渲染了，但 state 中无对应值，显示为空且无法保存

## 被否决的模式/反模式

- ❌ 仅添加 fields 渲染数组但不更新 fieldTypes 和 fieldIds —— 字段显示但无法保存，造成"假可用"状态
- ❌ 仅在中文 zh 字典中添加文案但不添加英文 en 字典 —— 英文界面下字段标签显示为 undefined
- ❌ 依赖后端自动生成 UI 而不修复客户端组件 —— 需要大幅度架构改动，不适用于当前问题

## 相关测试

- 无客户端渲染测试，验证方式为手动检查配置面板 UI 和保存/读取配置

## 变更边界

- 仅 client/client.js 文件变更，涉及 5 个 ADR 配置字段的渲染
- 后端 index.ts 的 Config schema 定义不需要修改
- 当新增配置字段时，需同步更新 client/client.js 的 fields 数组、fieldTypes 映射、fieldIds 列表和本地化字典