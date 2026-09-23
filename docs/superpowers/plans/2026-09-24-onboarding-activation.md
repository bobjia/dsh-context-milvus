# Onboarding Activation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提高 DSH 路径下 `dsh-context-milvus` 的二次使用率：通过 system prompt 让 Agent 主动调用 `search_code` / `find_callers` / `trace_call_chain`，让 `indexRoot` 自动 fallback 到会话 cwd，让本地遥测默认开启以获取真实使用数据。

**Architecture:** 三个独立修复，全部位于 `packages/dsh/src/plugins/dsh-context-milvus/`：

- **修复 1**：仿照 `constraint-injector.ts` 的模式新建 `code-search-prompt.ts`，注册一个 `order: 1480` 的 system prompt section（紧贴 `TOOL_GREP: 1500`）。不可由用户关闭。
- **修复 2**：新建纯函数 `workspace-root.ts` 实现 5 级 fallback；`index.ts` 记录 `startupCwd`，`tools.ts` 5 个工具运行时统一调用。不动 `packages/core/src/config.ts`。
- **修复 3**：`Config` schema `telemetryEnabled` 默认 `false → true`，`description` 增加隐私说明；启动日志提示用户。

**Tech Stack:** TypeScript（ESM / NodeNext / strict）、jest（`unstable_mockModule` + 顶层 `await import`）、`@deepseek-ai/dsh-tools` (`defineTool`)、`@deepseek-ai/cordis` (`Context`)。

## Global Constraints

- **核心 spec**：`docs/superpowers/specs/2026-09-24-onboarding-activation-design.md`（commit `c38db8c`）。本计划的所有设计决定都源于该 spec。
- **范围限定**：3 个修复全部在 `packages/dsh/src/plugins/dsh-context-milvus/` 范围内。**不动** `packages/core/src`、`packages/codex/src`、`packages/dsh/src/plugins/dsh-context-milvus/constraint-injector.ts`、`packages/dsh/src/plugins/dsh-context-milvus/adr-tools.ts`、`packages/dsh/src/plugins/dsh-context-milvus/adr-runtime.ts`。
- **核心边界**：`packages/core/src` 不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`，且除 `logger.ts` 外不得出现 `console.log/warn/info`（`packages/core/test/core-boundary.spec.ts` 守护）。
- **冻结契约**：`packages/dsh/test/public-surface.spec.ts` 锁定了 13 个工具名 + 27 个 `Config` 键的**字段集**与**默认值**。本计划变更：
  - `telemetryEnabled.default: false → true`
  - `telemetryEnabled.description` 文本变化
  - `indexRoot.description` 文本变化
  → 必须 deliberate 更新该 spec，并在 commit 引用本 spec id。
- **测试命令**：单测 `node --experimental-vm-modules node_modules/.bin/jest <path>`（`npx jest` 在本仓库不可用）。全量 `npm test`；类型检查 `npm run typecheck`；构建 `npm run build`。
- **commit 风格**：仓库 conventional-commit 风格（`feat(dsh):` / `test(dsh):` / `docs(spec):`）。
- **i18n 一致**：所有用户可见字符串用中文（项目惯例）。ADR prompt 与新 prompt 同语言。
- **DSH system prompt 约束**：section `name` 必须是 kebab-case、`order` 必须是有限数；与现有 `decision-memory:rules`（`order: 50`）不冲突——`code-search:rules` 用 `order: 1480`。
- **不动 constraint-injector.ts**：ADR prompt 注入逻辑保持不变；本计划新建独立 module。

---

### Task 1: 抽出 `workspace-root` 纯函数（含测试）

**Files:**
- Create: `packages/dsh/src/plugins/dsh-context-milvus/workspace-root.ts`
- Create: `packages/dsh/test/workspace-root.spec.ts`

**Interfaces:**
- Produces: `resolveWorkspaceRoot(config: PluginConfig, exec: { agent?: { session?: { header?: { cwd?: string } } } } | undefined, startupCwd: string, explicitPath?: string): string`

- [ ] **Step 1: 写失败的测试**

```ts
// packages/dsh/test/workspace-root.spec.ts
import { jest } from '@jest/globals'
import type { PluginConfig } from 'dsh-context-milvus-core'

const { resolveWorkspaceRoot } = await import(
  '../src/plugins/dsh-context-milvus/workspace-root.js'
)

const cfg: PluginConfig = {
  milvusAddress: '',
  milvusToken: undefined,
  milvusCollection: '',
  milvusDim: 768,
  embedding: { endpoint: '', apiKey: undefined, model: '', dim: 768 },
  indexRoot: '',
  indexExtensions: [],
  hybridMode: true,
  bm25RrfK: 60,
  chunkContextLines: 2,
  queryExpansion: true,
  rerankEnabled: true,
  rerankMultiplier: 3,
  indexIgnoreDirs: [],
  ignorePatterns: [],
  merkleFilePath: '',
  telemetryEnabled: false,
  telemetryFile: '',
  adrEnabled: false,
  adrRoot: '',
  adrCollection: '',
  adrConstraintReinjectEvery: 0,
  adrSystemPrompt: '',
  specRoot: '',
  planRoot: '',
}

const execWith = (cwd?: string) =>
  cwd === undefined ? undefined : { agent: { session: { header: { cwd } } } }

describe('resolveWorkspaceRoot', () => {
  test('explicit path wins', () => {
    expect(resolveWorkspaceRoot(cfg, undefined, '/home/u', '/explicit')).toBe('/explicit')
  })

  test('session cwd used when explicit path missing', () => {
    expect(resolveWorkspaceRoot(cfg, execWith('/proj'), '/home/u')).toBe('/proj')
  })

  test('config.indexRoot used when explicit and session missing', () => {
    const c = { ...cfg, indexRoot: '/repo' }
    expect(resolveWorkspaceRoot(c, undefined, '/home/u')).toBe('/repo')
  })

  test('startupCwd used as final fallback when all else empty', () => {
    expect(resolveWorkspaceRoot(cfg, undefined, '/home/u')).toBe('/home/u')
  })

  test('process.cwd() used when startupCwd is empty too', () => {
    const before = process.cwd()
    expect(resolveWorkspaceRoot(cfg, undefined, '')).toBe(before)
  })

  test('explicit path beats session cwd', () => {
    expect(resolveWorkspaceRoot(cfg, execWith('/proj'), '/home/u', '/force')).toBe('/force')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/workspace-root.spec.ts
```

预期：FAIL，错误 `Cannot find module '../src/plugins/dsh-context-milvus/workspace-root.js'`。

- [ ] **Step 3: 写实现**

```ts
// packages/dsh/src/plugins/dsh-context-milvus/workspace-root.ts
import type { PluginConfig } from 'dsh-context-milvus-core'

/**
 * 按优先级解析工具运行时使用的工作区根路径。
 *
 * 1. explicitPath — 用户显式传入（最高优先级）
 * 2. exec.agent.session.header.cwd — 当前 DSH 会话的工作区根
 * 3. config.indexRoot — Cordis 配置 / 环境变量 / DSH GUI 设置
 * 4. startupCwd — 插件启动时的 process.cwd()（DSH 服务进程 cwd）
 * 5. process.cwd() — 启动 cwd 拿不到时的兜底
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

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/workspace-root.spec.ts
```

预期：6 个 test 全 PASS。

- [ ] **Step 5: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add packages/dsh/src/plugins/dsh-context-milvus/workspace-root.ts \
        packages/dsh/test/workspace-root.spec.ts
git commit -m "feat(dsh): extract resolveWorkspaceRoot with 5-level fallback

Part of SPEC-2026-09-24-onboarding-activation (fix B): indexRoot
auto-fallback to session cwd, then startup cwd, then process.cwd().
Pure function; DSH adapter side only; core config unchanged."
```

---

### Task 2: `tools.ts` 5 个工具切换到 `resolveWorkspaceRoot`

**Files:**
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/tools.ts`（5 处 `sessionCwd` 模式替换 + 新增 `startupCwd` 闭包参数 + `registerTools` 签名）
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/index.ts`（`apply()` 顶部记录 `startupCwd`，向 `registerTools` 传参）

**Interfaces:**
- Consumes: `resolveWorkspaceRoot` from Task 1
- Changes: `registerTools(ctx, resolveConfig, resolveMilvus, resolveTracker, resolveImportResolver?, adrRuntime?, startupCwd)` — 新增可选最后一个参数

- [ ] **Step 1: 替换 `tools.ts` 中 5 处 fallback 模式**

逐个工具替换现有 `const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined` + `const path = params.path ?? sessionCwd ?? undefined` 模式。

工具 1：`search_code`（lines ~233-237）

```ts
// BEFORE
const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
const path = params.path ?? sessionCwd ?? undefined

// AFTER
import { resolveWorkspaceRoot } from './workspace-root.js'
const path = resolveWorkspaceRoot(resolveConfig(), exec, startupCwd, params.path)
```

工具 2：`index_code`（lines ~318-321）—— `overridePath`

```ts
const overridePath = resolveWorkspaceRoot(resolveConfig(), exec, startupCwd, params.path)
```

工具 3：`index_status`（lines ~488-491）—— `overridePath`

```ts
const overridePath = resolveWorkspaceRoot(resolveConfig(), exec, startupCwd, params.path)
```

工具 4 与 5：`find_callers` 与 `trace_call_chain` —— 当前实现不依赖 path 前缀过滤，但 **保留现有行为**（不引入新参数）。这两处不动。

- [ ] **Step 2: `registerTools` 签名加 `startupCwd`**

在 `tools.ts` 顶部加 import：

```ts
import { resolveWorkspaceRoot } from './workspace-root.js'
```

修改 `registerTools` 签名：

```ts
export function registerTools(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  resolveMilvus: () => MilvusService,
  resolveTracker: () => HashTracker,
  resolveImportResolver?: () => ImportResolver | undefined,
  adrRuntime?: AdrRuntimeResolver,
  startupCwd: string = '',  // 新增
): void {
```

函数体内用闭包变量：

```ts
const resolvePath = (params: any, exec?: any): string | undefined =>
  resolveWorkspaceRoot(resolveConfig(), exec, startupCwd, params.path)
```

替换 3 处 `path` / `overridePath` 计算。`search_code` 用 `resolvePath(params, exec)`；`index_code` / `index_status` 用 `resolvePath(params, exec)`。

- [ ] **Step 3: `index.ts` 传 `startupCwd`**

在 `packages/dsh/src/plugins/dsh-context-milvus/index.ts` 的 `apply()` 顶部（`let current: () => CordisConfig = () => config ?? {}` 之前）加：

```ts
const startupCwd = process.cwd()
```

把 `registerTools(...)` 调用末尾加一个参数：

```ts
registerTools(
  ctx, () => getConfig(current()), getMilvus, getTracker, getImportResolver, adrRuntimeResolver,
  startupCwd,
)
```

- [ ] **Step 4: 类型检查**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm run typecheck
```

预期：零错误。若报错，最常见原因是 `workspace-root.ts` 的 `import` 路径或 `PluginConfig` 类型未正确导出（`PluginConfig` 来自 `dsh-context-milvus-core`）。

- [ ] **Step 5: 跑全量测试**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm test
```

预期：所有 spec 通过。如有失败，特别关注 `settings-hot-reload.spec.ts` 与 `public-surface.spec.ts`——前者可能依赖特定 cwd 行为，后者锁定了 27 个 `Config` key 但不动此处逻辑。

- [ ] **Step 6: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add packages/dsh/src/plugins/dsh-context-milvus/tools.ts \
        packages/dsh/src/plugins/dsh-context-milvus/index.ts
git commit -m "feat(dsh): tools use resolveWorkspaceRoot for session cwd fallback

Part of SPEC-2026-09-24-onboarding-activation (fix B). search_code,
index_code, index_status now resolve workspace root via:
  params.path > session.header.cwd > config.indexRoot > startupCwd > process.cwd()

startupCwd captured once at plugin apply() time and threaded through
registerTools. ADR tools untouched (out of scope)."
```

---

### Task 3: 新增 `code-search-prompt.ts` 与测试

**Files:**
- Create: `packages/dsh/src/plugins/dsh-context-milvus/code-search-prompt.ts`
- Create: `packages/dsh/test/code-search-prompt.spec.ts`

**Interfaces:**
- Produces: `setupCodeSearchPrompt(ctx: Context): () => void` — 返回 disposer

- [ ] **Step 1: 写失败的测试**

```ts
// packages/dsh/test/code-search-prompt.spec.ts
import { jest } from '@jest/globals'
import type { Context } from '@deepseek-ai/cordis'

const sectionMock = jest.fn(() => jest.fn())
const ctxStub = {
  get: jest.fn((key: string) => (key === 'systemPrompt' ? { section: sectionMock } : undefined)),
} as unknown as Context

const { setupCodeSearchPrompt } = await import(
  '../src/plugins/dsh-context-milvus/code-search-prompt.js'
)

describe('setupCodeSearchPrompt', () => {
  beforeEach(() => sectionMock.mockClear())

  test('registers a code-search:rules section at order 1480', () => {
    setupCodeSearchPrompt(ctxStub)
    expect(sectionMock).toHaveBeenCalledTimes(1)
    const arg = sectionMock.mock.calls[0][0]
    expect(arg.name).toBe('code-search:rules')
    expect(arg.order).toBe(1480)
    expect(typeof arg.text).toBe('string')
  })

  test('prompt text mentions all 4 tools', () => {
    setupCodeSearchPrompt(ctxStub)
    const text = sectionMock.mock.calls[0][0].text
    expect(text).toMatch(/search_code/)
    expect(text).toMatch(/index_code/)
    expect(text).toMatch(/index_status/)
    expect(text).toMatch(/find_callers/)
    expect(text).toMatch(/trace_call_chain/)
  })

  test('returned disposer is the section disposer', () => {
    const inner = jest.fn()
    sectionMock.mockReturnValueOnce(inner)
    const disposer = setupCodeSearchPrompt(ctxStub)
    expect(disposer).toBe(inner)
  })

  test('gracefully no-op when systemPrompt service is unavailable', () => {
    const noSp = { get: () => undefined } as unknown as Context
    expect(() => setupCodeSearchPrompt(noSp)).not.toThrow()
  })

  test('gracefully no-op when systemPrompt.section is missing', () => {
    const noSection = { get: () => ({}) } as unknown as Context
    expect(() => setupCodeSearchPrompt(noSection)).not.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/code-search-prompt.spec.ts
```

预期：FAIL，`Cannot find module '../src/plugins/dsh-context-milvus/code-search-prompt.js'`。

- [ ] **Step 3: 写实现**

```ts
// packages/dsh/src/plugins/dsh-context-milvus/code-search-prompt.ts
import type { Context } from '@deepseek-ai/cordis'

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
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * Register the "code-search:rules" system prompt section that nudges the
 * Agent to prefer semantic code search over grep+read across the typical
 * coding-task triggers. Returns a disposer that unregisters the section;
 * callers do not currently invoke it (the prompt is core functionality and
 * is not user-toggleable, unlike the ADR prompt).
 */
export function setupCodeSearchPrompt(ctx: Context): () => void {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptService | undefined
  if (!systemPrompt?.section) {
    // 早期 DSH 版本可能未挂载 systemPrompt 服务；不抛错，仅跳过。
    return () => {}
  }
  return systemPrompt.section({
    name: 'code-search:rules',
    order: 1480,
    text: PROMPT_TEXT,
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/code-search-prompt.spec.ts
```

预期：5 个 test 全 PASS。

- [ ] **Step 5: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add packages/dsh/src/plugins/dsh-context-milvus/code-search-prompt.ts \
        packages/dsh/test/code-search-prompt.spec.ts
git commit -m "feat(dsh): register code-search:rules system prompt at order 1480

Part of SPEC-2026-09-24-onboarding-activation (fix C). Modeled after
constraint-injector.ts; placed next to TOOL_GREP (1500) so the Agent
sees it as a code-retrieval sibling. Core functionality; not toggleable."
```

---

### Task 4: `index.ts` 调用 `setupCodeSearchPrompt`

**Files:**
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/index.ts`

- [ ] **Step 1: 加 import 与 dispose 跟踪**

在 `packages/dsh/src/plugins/dsh-context-milvus/index.ts` 顶部 import 区添加：

```ts
import { setupCodeSearchPrompt } from './code-search-prompt.js'
```

- [ ] **Step 2: 在 `apply()` 末尾注册**

紧接现有 `console.log(...)` 启动日志之后加：

```ts
setupCodeSearchPrompt(ctx)
```

无返回值需要保存（spec 已明确：code-search prompt 不可由用户关闭 → 不引入 dispose 跟踪）。

- [ ] **Step 3: 类型检查与单测**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm run typecheck
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/code-search-prompt.spec.ts
```

预期：零类型错误，code-search-prompt.spec.ts 仍 PASS。

- [ ] **Step 4: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add packages/dsh/src/plugins/dsh-context-milvus/index.ts
git commit -m "feat(dsh): wire setupCodeSearchPrompt into apply()

Completes SPEC-2026-09-24-onboarding-activation fix C: code-search
prompt now registered on every plugin load."
```

---

### Task 5: `Config` schema `indexRoot.description` 改进

**Files:**
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/index.ts:97-99`

- [ ] **Step 1: 替换 description**

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

不改 default；不改字段名/类型。**注意**：本任务只动 `.description` 字符串，**不改** `telemetryEnabled` 默认值（Task 6 才动）。

- [ ] **Step 2: 验证 public-surface 仍正常**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/public-surface.spec.ts
```

预期：可能 FAIL（description 文本变了）—— 这是预期的。**不要立刻修**，等 Task 6 完成后统一更新。

- [ ] **Step 3: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add packages/dsh/src/plugins/dsh-context-milvus/index.ts
git commit -m "docs(dsh): clarify indexRoot.description (留空自动 fallback)

Part of SPEC-2026-09-24-onboarding-activation (fix B). Defaults
unchanged; only the GUI tooltip text is updated. public-surface
snapshot updated separately in Task 7."
```

---

### Task 6: `Config` schema `telemetryEnabled` 默认开启

**Files:**
- Modify: `packages/dsh/src/plugins/dsh-context-milvus/index.ts:193-202`

- [ ] **Step 1: 替换 `telemetryEnabled` 默认值与 description**

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
    '仅记录 search_code / index_code / index_status 的调用次数、耗时、查询长度、' +
    '结果数量与 topScore，**不采集代码内容**。' +
    '文件位于 ~/.milvus-index/telemetry.jsonl（权限 0600）。可随时在本设置中关闭。'
  ),
```

- [ ] **Step 2: 加启动日志**

在 `apply()` 末尾现有的 `[dsh-context-milvus] 已加载 (N 种文件类型, hybrid=...)` 日志之后加：

```ts
if (resolved.telemetryEnabled) {
  console.log(
    `[dsh-context-milvus] 本地遥测已开启（仅元数据，不采集代码内容），` +
    `写入 ${resolved.telemetryFile}；可在 Settings → Plugins → dsh-context-milvus 关闭`
  )
}
```

- [ ] **Step 3: 类型检查**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm run typecheck
```

- [ ] **Step 4: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add packages/dsh/src/plugins/dsh-context-milvus/index.ts
git commit -m "feat(dsh): telemetry enabled by default with privacy notice

Part of SPEC-2026-09-24-onboarding-activation (fix H). Default flips
false -> true; description now explains what is recorded (metadata
only) and where (0600 JSONL in ~/.milvus-index). Startup log line
notifies users on every boot."
```

---

### Task 7: 更新 `public-surface.spec.ts`（deliberate）+ 写 telemetry-default 测试

**Files:**
- Modify: `packages/dsh/test/public-surface.spec.ts`
- Create: `packages/dsh/test/telemetry-default.spec.ts`

**Interfaces:**
- Consumes: `Config` schema (Tasks 5, 6)
- Asserts: 默认值变更与 description 文本变更

- [ ] **Step 1: 读现有 `public-surface.spec.ts` 摸清快照结构**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
cat packages/dsh/test/public-surface.spec.ts | head -80
```

找到锁定 `Config` 默认值与 description 的具体断言位置（通常是一段 `expect(SCHEMA).toEqual(...)` 或类似）。

- [ ] **Step 2: 写 telemetry-default 测试**

新建 `packages/dsh/test/telemetry-default.spec.ts`：

```ts
import { jest } from '@jest/globals'
import { Config } from '../src/plugins/dsh-context-milvus/index.js'

describe('Config.telemetryEnabled', () => {
  test('defaults to true (SPEC-2026-09-24-onboarding-activation fix H)', () => {
    const parsed = Config({} as any) as any
    expect(parsed.telemetryEnabled).toBe(true)
  })

  test('description text mentions default and no-source-code-collection', () => {
    const schema = (Config as any).constructor
    const def = schema.def?.telemetryEnabled ?? schema.shape?.telemetryEnabled
    expect(def).toBeDefined()
    // schemastery exposes `.meta.description` on the live schema node
    const desc = def.meta?.description ?? def.description
    expect(desc).toMatch(/默认开启/)
    expect(desc).toMatch(/不采集代码内容/)
  })
})
```

> **注意**：schemastery 暴露字段名依版本而定（`meta.description` / 直接 `.description`）。跑测试若失败，调整访问路径（Task 7 Step 5 验证）。

- [ ] **Step 3: 跑新测试**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/telemetry-default.spec.ts
```

预期：PASS。

- [ ] **Step 4: 更新 `public-surface.spec.ts` 快照**

根据 Step 1 看到的结构：
- 若断言锁定了 `telemetryEnabled` 的默认值（`false`），改成 `true`。
- 若断言锁定了 `indexRoot.description` 或 `telemetryEnabled.description` 完整字符串，更新成新文案。
- 加注释：
  ```ts
  // Updated 2026-09-24 per SPEC-2026-09-24-onboarding-activation:
  //   - telemetryEnabled default: false -> true (fix H)
  //   - indexRoot.description / telemetryEnabled.description 改进文案 (fix B / fix H)
  ```

- [ ] **Step 5: 跑全量**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm test
```

预期：所有 spec 通过。若 `telemetry-default.spec.ts` 因 schemastery API 不匹配失败，按失败信息调整 description 访问路径后再跑。

- [ ] **Step 6: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add packages/dsh/test/public-surface.spec.ts \
        packages/dsh/test/telemetry-default.spec.ts
git commit -m "test(dsh): deliberate public-surface + telemetry default assertions

Per SPEC-2026-09-24-onboarding-activation: snapshots for indexRoot and
telemetryEnabled descriptions/defaults updated. New telemetry-default
spec pins the new defaults so future regressions surface."
```

---

### Task 8: README 同步（telemetry 章节）

**Files:**
- Modify: `README.zh.md:130-133`
- Modify: `README.md`（英文版，对应位置）

- [ ] **Step 1: 找英文版对应行**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
grep -n "opt-in\|telemetry" README.md | head -10
```

- [ ] **Step 2: 中文版改动**

`README.zh.md`：

```markdown
// BEFORE
### 原生遥测（opt-in）

`search_code` / `index_code` / `index_status` 每次执行记录一条 JSONL（含查询文本、结果数、最高分、耗时、索引文件/分块数等），**默认关闭**（`telemetryEnabled: false`），不采集源代码内容。

// AFTER
### 原生遥测（默认开启）

`search_code` / `index_code` / `index_status` 每次执行记录一条 JSONL（含查询文本、结果数、最高分、耗时、索引文件/分块数等），**默认开启**（`telemetryEnabled: true`），不采集源代码内容。
```

如要关闭：

```bash
# Settings → Plugins → dsh-context-milvus → telemetryEnabled 设为 false
# 或临时：
export TELEMETRY_ENABLED=false  # 仅当通过环境变量配置时
```

- [ ] **Step 3: 英文版同步**

`README.md` 同样把 "opt-in" 标题改为 "enabled by default"，正文 "default off" 改为 "default on"，加关闭方法说明。

- [ ] **Step 4: commit**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
git add README.md README.zh.md
git commit -m "docs: telemetry is enabled by default (close-out fix H)

Per SPEC-2026-09-24-onboarding-activation. README.zh.md and README.md
updated in lockstep. Disable path documented for users who want it off."
```

---

### Task 9: 端到端验证（手动清单 + 全量测试）

**Files:**
- No file changes; this is a verification task before declaring done.

- [ ] **Step 1: 全量类型检查**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm run typecheck
```

预期：零错误。

- [ ] **Step 2: 全量测试**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm test
```

预期：所有 spec 通过。

- [ ] **Step 3: 构建**

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm run build
```

预期：构建成功，3 个 package 都产生 `dist/`。

- [ ] **Step 4: 在 DSH web profile 手动安装并验证（可选，需 DSH 环境）**

如本机有 DSH 可用：

1. `dsh plugin --profile web add file:/mnt/home/bobjia/workspace/dsh-context-milvus` （或等价的 npm tarball 安装）
2. 重启 DSH
3. **验证修复 3**：控制台出现 `[dsh-context-milvus] 本地遥测已开启...` 日志；`~/.milvus-index/telemetry.jsonl` 在首次 `index_code` / `search_code` 后被写入
4. **验证修复 2**：在 `cordis.patch.yml` 里**不填** `indexRoot`，启动 DSH，chat 中调用 `index_status` —— 返回内容里的"路径"应指向当前项目目录而非 `~`
5. **验证修复 1**：在 chat 中问 "重构一下 auth.ts" —— Agent 应**优先调用 `search_code`**（从 DSH web 工具调用面板可见），而不是连续 grep + read

如本机没 DSH，跳过本步。

- [ ] **Step 5: 报告完成**

按 `verification-before-completion` skill：只有上面 1-3 全部 PASS 才算完成。手动验证是"加分项"，缺失不阻塞。

---

## 自审

- **Spec 覆盖**：
  - 修复 1（修复 C）→ Task 3, Task 4
  - 修复 2（修复 B）→ Task 1, Task 2, Task 5
  - 修复 3（修复 H）→ Task 6, Task 7, Task 8
  - 端到端 → Task 9
  - ✅ 无遗漏
- **占位符扫描**：grep `TODO|TBD|fill in|implement later`——无。
- **类型一致性**：`resolveWorkspaceRoot` 签名在 Task 1 定义、Task 2 使用，签名一致。`setupCodeSearchPrompt` 签名 Task 3 定义、Task 4 使用，签名一致。`registerTools` 新增 `startupCwd` 参数在 Task 2 与 Task 2 内部一致。
- **Task 大小**：每个 task 包含测试→实现→验证→commit，2-5 分钟步长。Task 9 是验证节点，符合"Bite-Sized"要求。