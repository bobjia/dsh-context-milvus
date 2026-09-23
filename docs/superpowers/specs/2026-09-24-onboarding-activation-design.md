---
title: onboarding-activation
type: spec
created: 2026-09-24
status: draft
id: SPEC-2026-09-24-onboarding-activation
related_decisions:
  - ADR-0011-tool-output-lossless-json-null-convention
---

# DSH 路径的首次使用激活（onboarding activation）

## 概要

DSH 适配器（`packages/dsh`）当前注册了 5 个代码检索工具，但出现"装上很快放弃 / 一次性使用"现象。本 spec 修复其中 3 个根因（Phase 1 报告里的 C/B/H），用最小的改动让 Agent 在编码任务里主动调用 `search_code`，让首次配置不再指向错误的目录，让维护者有真实使用数据继续优化。

## 背景与约束

### Phase 1 报告（结构化证据）

| # | 根因 | 修复 |
|---|---|---|
| C | `search_code` 没有 system prompt 引导 | 修复 1 |
| B | `indexRoot` 默认 `process.cwd()` 与用户期望的 session cwd 错位 | 修复 2 |
| H | `telemetryEnabled` 默认关闭，没有真实使用率数据 | 修复 3 |

不动的根因：安装门槛（修复 A，长期工作）、中文 query expansion（修复 D）、大工作区 deferred（修复 F）、失败信号不可见（修复 E）。

### 关键事实（写入设计前已验证）

- DSH 的 system prompt 有 `SECTION_ORDERS` 常量（`@deepseek-ai/dsh-system-prompt/lib/index.js`）：
  - `TOOL_GREP: 1500` —— 已存在的内置检索工具
  - `TOOL_WEB_SEARCH: 2000` —— 外部检索类
  - 我注册的 `code-search:rules` 用 `order: 1480`，紧贴 `TOOL_GREP`，与"代码检索"语义同层
- `Config` schema 默认 `telemetryEnabled: false`（index.ts:194）
- `indexRoot` 在 schema 默认 `''`（index.ts:98），`getConfig()` 回退到 `process.cwd()`（config.ts:269）
- ADR 模块通过 `systemPrompt.section({ name: 'decision-memory:rules', order: 50 })` 注册 prompt 段（constraint-injector.ts:97-102），已有现成模式可借鉴

### 约束（隐含）

- **Core 边界**：`packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`（`packages/core/test/core-boundary.spec.ts` 守护）。DSH 适配器可以。
- **公共契约冻结**：`packages/dsh/test/public-surface.spec.ts` 锁定 13 个工具名 + 27 个 `Config` key 的默认值与字段集。本 spec 涉及 3 个 `Config` 字段（`telemetryEnabled`、`telemetryFile`、`indexRoot`）的描述/默认值变化 → 必须 deliberate 更新该 spec，并在 commit 里引用本 spec id。
- **i18n 一致**：所有用户可见字符串用中文（项目惯例）。ADR prompt 已用中文，新 prompt 同样用中文。
- **不破坏现有用户**：所有改动向后兼容。`telemetryEnabled` 默认 `true` 时，老用户下次重启会写入 telemetry.jsonl——这是首次写入，不会无报错。
- **不依赖 core 改动**：3 个修复全部在 `packages/dsh/src/plugins/dsh-context-milvus/` 范围内，避免与同时进行的 ADR/Codex 改动冲突。

---

## 设计

### 修复 1：代码检索 system prompt 引导

#### 1.1 新文件 `code-search-prompt.ts`

仿照 `constraint-injector.ts` 的 pattern：导出 `setupCodeSearchPrompt(ctx)`，返回 disposer。

```ts
// packages/dsh/src/plugins/dsh-context-milvus/code-search-prompt.ts

const PROMPT_TEXT = `## 代码检索与关系分析规则

你拥有以下语义检索与代码关系工具：
- search_code：跨文件按语义搜索代码实现（自然语言 query）
- index_code：首次使用前必须先索引代码仓库
- index_status：查看当前代码索引状态
- find_callers：查某个符号被谁引用 / 它引用了谁
- trace_call_chain：BFS 追踪函数调用链（影响分析 / 依赖分析）

### 必须遵守的规则

1. **编码任务开始前**：
   - 先调用 \`index_status\` 检查当前工作区是否已索引
   - 未索引则调用 \`index_code\`（默认增量模式）启动索引
   - 大工作区（>1000 文件）时按工具提示在终端运行备用命令

2. **以下场景必须优先调用 \`search_code\` 而非 grep + read**：
   - 用户描述含 "在哪里"、"怎么实现"、"类似"、"重构"、"定位 bug"、"跨文件理解"
   - 你打算连续 grep + read 超过 2 个文件
   - 任务涉及不熟悉的代码区域、需要快速建立上下文
   - 用户问 "这段代码做了什么"、"为什么这么写" 时，先用 search_code 找相关定义

3. **修改前的影响分析**：
   - 修改函数/类/导出符号前，先用 \`find_callers(symbol=..., direction=backward)\` 查看引用
   - 跨文件场景加 \`sourceFile\` 参数做精确消歧
   - 复杂改动用 \`trace_call_chain\` 追踪多层调用链

4. **禁止行为**：
   - ❌ 跳过 index_code 直接 grep（重复劳动、浪费 token）
   - ❌ 拿到 search_code 空结果就放弃（先确认索引状态、调整 query 措辞）
   - ❌ 用 find_callers 但不传 direction（默认 backward，但 forward 用于依赖分析）`

interface SystemPromptService {
  section(section: { name: string; order: number; text: string | (() => string) }): () => void
}

export function setupCodeSearchPrompt(ctx: Context): () => void {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptService | undefined
  if (!systemPrompt?.section) {
    // 早期 DSH 版本可能没装 systemPrompt；不抛错，仅跳过
    return () => {}
  }
  return systemPrompt.section({
    name: 'code-search:rules',
    order: 1480,
    text: PROMPT_TEXT,
  })
}
```

#### 1.2 `index.ts` 集成

在 `apply()` 末尾（`registerTools(...)` 之后）添加：

```ts
const codeSearchPromptDisposer = setupCodeSearchPrompt(ctx)
```

暂存到 `apply()` 局部变量即可。`apply()` 当前没有模块级 disposers 数组——暂不引入，避免与 ADR 的 `toggleAdr` 模式冲突；如未来需要卸载插件时统一释放，再重构。

#### 1.3 不可关闭

与 ADR 不同：`ADR_ENABLED` 可以关闭，`code-search:rules` 始终注册（code search 是核心功能）。

#### 1.4 测试

`packages/dsh/test/code-search-prompt.spec.ts`：
- 验证 `setupCodeSearchPrompt(ctx)` 调用了 `ctx.systemPrompt.section({ name: 'code-search:rules', order: 1480, text: <含 search_code 关键词> })`
- 验证 disposer 调用后 section 被注销
- 验证 `ctx.systemPrompt` 不存在时不抛错

参考 `packages/dsh/test/constraint-injector.spec.ts` 的 mock 模式。

---

### 修复 2：indexRoot 自动 fallback 到 session cwd

#### 2.1 新文件 `workspace-root.ts`

```ts
// packages/dsh/src/plugins/dsh-context-milvus/workspace-root.ts

import type { PluginConfig } from 'dsh-context-milvus-core'

/**
 * 按优先级解析工具运行时使用的工作区根路径。
 *
 * 1. params.path —— 用户显式传入（最高优先级）
 * 2. session.header.cwd —— 当前 DSH 会话的工作区根
 * 3. config.indexRoot —— Cordis 配置 / 环境变量 / DSH GUI 设置
 * 4. startupCwd —— 插件启动时的 process.cwd()（**DSH 服务进程 cwd**，通常 ~）
 * 5. process.cwd() —— 启动 cwd 拿不到时的兜底
 */
export function resolveWorkspaceRoot(
  config: PluginConfig,
  exec: { agent?: { session?: { header?: { cwd?: string } } } } | undefined,
  startupCwd: string,
  explicitPath?: string,
): string {
  if (explicitPath) return explicitPath
  const sessionCwd = exec?.agent?.session?.header?.cwd
  if (sessionCwd) return sessionCwd
  if (config.indexRoot) return config.indexRoot
  return startupCwd || process.cwd()
}
```

#### 2.2 `index.ts` 集成

在 `apply()` 顶部记录：

```ts
const startupCwd = process.cwd()
```

把 `startupCwd` 作为额外参数传给 `registerTools(...)`。`registerTools` 签名增加 `startupCwd: string` 参数，向下传到 5 个工具闭包。

#### 2.3 `tools.ts` 改动

5 个工具（`search_code` / `index_code` / `index_status` / `find_callers` / `trace_call_chain`）的现有代码模式：

```ts
// BEFORE
const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
const path = params.path ?? sessionCwd ?? undefined

// AFTER
import { resolveWorkspaceRoot } from './workspace-root.js'
const path = resolveWorkspaceRoot(resolveConfig(), exec, startupCwd, params.path)
```

注意：ADR 工具里 `workspaceRootForExec`（`adr-runtime.ts:66`）实现相同意图但走 ADR bundle。本 spec 不动 ADR 路径以免扩散范围，但 `workspace-root.ts` 的纯函数可被 ADR 工具后续迁移（不在本 spec 范围）。

#### 2.4 `Config` schema 文档更新

`packages/dsh/src/plugins/dsh-context-milvus/index.ts:97-99`：

```ts
// BEFORE
indexRoot: z.string()
  .default('')
  .description('代码仓库根路径，用于索引时扫描文件'),

// AFTER
indexRoot: z.string()
  .default('')
  .description(
    '代码仓库根路径，用于索引时扫描文件。' +
    '留空时自动使用当前 DSH 会话工作目录；通常无需手动填写。'
  ),
```

#### 2.5 不动 `packages/core/src/config.ts`

`getConfig()` 的 fallback 逻辑（`config.ts:269`）保持 `process.cwd()`，向后兼容。DSH 适配器在 `resolveWorkspaceRoot` 里覆盖这个 fallback。

#### 2.6 测试

`packages/dsh/test/workspace-root.spec.ts`：

| 场景 | `params.path` | `session.cwd` | `config.indexRoot` | `startupCwd` | 期望 |
|---|---|---|---|---|---|
| 显式 | `/foo` | — | — | — | `/foo` |
| Session | — | `/proj` | `''` | `~` | `/proj` |
| Startup fallback | — | — | `''` | `~` | `~` |
| Config | — | — | `/repo` | — | `/repo` |
| 全空 | — | — | `''` | `''` | `process.cwd()` |

---

### 修复 3：telemetry 默认开启 + 设置说明

#### 3.1 `Config` schema 默认值变化

`packages/dsh/src/plugins/dsh-context-milvus/index.ts:194-196`：

```ts
// BEFORE
telemetryEnabled: z.boolean()
  .default(false)
  .description('启用本地遥测统计（search_code/index_code/index_status 写入 JSONL，默认关闭）'),

// AFTER
telemetryEnabled: z.boolean()
  .default(true)
  .description(
    '启用本地遥测统计（默认开启）。' +
    '仅记录 search_code/index_code/index_status 的调用次数、耗时、查询长度、结果数量与 topScore，' +
    '**不采集代码内容**。文件位于 ~/.milvus-index/telemetry.jsonl（权限 0600）。' +
    '可随时在本设置中关闭。'
  ),
```

#### 3.2 启动日志

`packages/dsh/src/plugins/dsh-context-milvus/index.ts` 在 `apply()` 末尾加：

```ts
if (resolved.telemetryEnabled) {
  console.log(
    `[dsh-context-milvus] 本地遥测已开启（仅元数据，不采集代码内容），` +
    `写入 ${resolved.telemetryFile}；可在 Settings → Plugins → dsh-context-milvus 关闭`
  )
}
```

放在现有的 `[dsh-context-milvus] 已加载 (N 种文件类型, hybrid=...)` 日志之后。

#### 3.3 README 同步

`README.zh.md:131-133`：
- 章节标题从 `### 原生遥测（opt-in）` 改为 `### 原生遥测（默认开启）`
- 第一句改为：`默认开启（可在 Settings → Plugins → dsh-context-milvus 关闭）`
- 说明关闭方法

#### 3.4 隐私安全网（验证不动）

- `sanitizeQuery()`（`packages/core/src/telemetry.ts`）已经存在 → 不动
- 文件权限 0600 由 `telemetry.ts` 设置 → 验证（`grep -n "0600" packages/core/src/telemetry.ts`）
- 写到 `~/.milvus-index/telemetry.jsonl`（用户家目录，不上传网络） → 已存在

#### 3.5 测试

- `packages/dsh/test/telemetry-default.spec.ts`（新）：验证 `Config` schema 解析后 `telemetryEnabled === true` 当用户没传值
- 更新 `packages/dsh/test/public-surface.spec.ts`（冻结测试）：27 个 `Config` key 的默认值快照需 deliberate 更新

---

## 跨修复影响

### `public-surface.spec.ts` 更新（强制 deliberate）

3 个修复都影响该测试：
- 修复 1：可能枚举 systemPrompt 注册（待确认）
- 修复 2：`indexRoot.description` 文本变化
- 修复 3：`telemetryEnabled.default` 从 false 变 true，description 文本变化

更新 spec 时加注释：

```ts
// Updated 2026-09-24 per SPEC-2026-09-24-onboarding-activation:
//   - indexRoot.description 改进文案
//   - telemetryEnabled default 从 false 改为 true（修复根因 H：缺少真实使用率数据）
```

### `settings-hot-reload.spec.ts`

确认现有测试不依赖 `telemetryEnabled` 默认值。如有，更新。

### ADR / Codex 适配器

本 spec 严格限定 DSH 适配器路径。`packages/codex/` 与 `packages/core/src/adr-*` **不动**。

---

## 数据流（修复 2 关键路径）

```
用户："帮我重构 user.ts 里的 handleLogin"
       ↓
Agent 接 prompt（含 system prompt section "code-search:rules"）
       ↓
Agent 决策：满足触发场景 #2（"重构" + 打算读多个文件）→ 优先 search_code
       ↓
Agent 调用 index_status(path=undefined)
       ↓
resolveWorkspaceRoot(config, exec, startupCwd, undefined)
  → session.header.cwd = "/home/u/proj"（DSH 注入）
  → 返回 "/home/u/proj"
       ↓
getIndexStatus(effectiveConfig={indexRoot:"/home/u/proj", ...})
       ↓
返回 "已索引文件: 145, 代码块: 832" 或 "从未索引"
       ↓
（若从未索引）Agent 调用 index_code() → 索引 "/home/u/proj"
       ↓
Agent 调用 search_code(query="处理用户登录的函数")
       ↓
Milvus 在 "/home/u/proj" 路径前缀下语义检索
       ↓
返回 handleLogin 实现 + 相关代码
       ↓
Agent 基于精准上下文做重构
       ↓
同时 telemetry.jsonl 写入一行：
  {"ts": "...", "tool": "search_code", "query": "处理用户登录的函数",
   "topK": 5, "resultCount": 4, "topScore": 0.87, "durationMs": 215,
   "queryExpansionApplied": false, "rerankEnabled": true, ...}
```

---

## 验证方案

### 单元测试
- `code-search-prompt.spec.ts` — 注册/注销/不可用时跳过
- `workspace-root.spec.ts` — 5 个 fallback 场景
- `telemetry-default.spec.ts` — Config 默认值
- 更新 `public-surface.spec.ts` 与（可能）`settings-hot-reload.spec.ts`

### 端到端验证（手动）

1. 清空 `~/.milvus-index/`（fresh start）
2. `npm run build` + 在 DSH web profile 装上插件
3. 重启 DSH
4. **修复 1 验证**：在 Settings → Plugins → dsh-context-milvus 看不到 system prompt（DSH 不暴露），但 chat 里问 "重构一下 auth.ts" 时观察 Agent 是否调用 `search_code` 而不是 `grep` + `read`
5. **修复 2 验证**：在 `~/.dsh/profiles/web/cordis.patch.yml` 里**不填** `indexRoot`，启动 DSH，chat 里调用 `index_status` —— 看返回的 `indexRoot` 是不是当前项目目录
6. **修复 3 验证**：`~/.milvus-index/telemetry.jsonl` 应当出现，且首次执行 `index_code` 后有一行日志；控制台启动日志含"本地遥测已开启"

### 回归风险

- 修复 1 风险：system prompt 长度增加 → token 开销变高。预期 +200 token / turn，影响可忽略
- 修复 2 风险：startupCwd 与 session cwd 不一致时，行为从"索引 DSH 进程 cwd"变成"索引用户 chat cwd"——更符合用户预期，但已是默认行为的**改变**。属于行为修复，不是破坏
- 修复 3 风险：默认开启 telemetry，老用户首次重启会突然看到 telemetry.jsonl 写入。已用 console.log 通知，但属于行为变化

### 回滚

3 个修复相互独立，每个独立 commit，可独立 revert。

---

## 范围

### 包含
- 修复 1（system prompt）
- 修复 2（indexRoot fallback）
- 修复 3（telemetry 默认开启）
- 各自单元测试
- `public-surface.spec.ts` deliberate 更新
- README 同步（修复 3 段落）

### 不包含（明确划出去）
- 中文 query expansion 同义词（修复 D，独立 spec）
- 安装门槛优化（修复 A，长线）
- 大工作区 deferred 改造（修复 F，独立 spec 已存在）
- 失败信号暴露到 GUI（修复 E，可与修复 1 合并后续做）
- ADR 路径同步迁移到 `workspace-root.ts`（可作后续重构）
- Codex 适配器改动（独立 spec）

---

## 风险与权衡

| 选择 | 不选的理由 |
|---|---|
| 修复 1 不可关闭 | 用户若不需要可去 settings 关 ADR prompt，code search 是核心不可关 |
| 修复 2 不动 core config fallback | 改动 core 会影响 Codex 适配器路径，超范围 |
| 修复 3 默认开启 telemetry | 用户隐私敏感，但 (1) 只本地 JSONL、(2) 不采集代码、(3) DSH 控制台明确通知、(4) 默认值变化在 description 里写明 |
| 修复 2 不写回 config.indexRoot | 如果写回，启动后 session cwd 变化时索引被锁在第一次启动目录，违反"会话级"语义 |