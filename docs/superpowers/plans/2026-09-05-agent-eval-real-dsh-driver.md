# 真实 DSH driver 接入说明（Plan 2 配套）

> 本文档说明如何为 `scripts/eval/agent/` 写一个**真实 DSH Agent driver**，让端到端评测 harness 从 `simulated.mjs` 切换到真实 DSH 运行。适用于有 DSH 宿主环境的机器（插件经 DSH CLI 安装，见 [README](file:///workspace/README.md#L208)）。

## 1. Driver 契约（与 Plan 2 一致）

每个 `(task, group, run)` 由 `run.mjs` 派生一个独立子进程：

```
node <driver> --task <taskId> --group <G|R|P> --root <workspaceDir>
```

* `--task`：任务 ID（`sample-tasks.json` 中的 `id`）

* `--group`：三组之一 `G | R | P`

* `--root`：工作目录（driver 在此 checkout 仓库、跑测试）

输出契约（stdout 单行 JSON，exit 0）：

```json
{ "passed": true, "tokens": 12345, "toolCalls": 18, "durationMs": 94000 }
```

* `passed`：bool，必填

* `tokens` / `toolCalls`：int；宿主不暴露时输出 `null`，报告会如实标注

* `durationMs`：int，agent 运行耗时

* stderr 仅用于日志，不参与解析（`run-agent.mjs` 忽略 stderr）

## 2. 三组检索策略 → DSH 运行配置

唯一变量是「检索引擎」，其余（LLM、温度、system prompt、任务）三组完全一致。

| 组     | DSH 插件配置                         | 检索方式                      |
| ----- | -------------------------------- | ------------------------- |
| **G** | 不加载 `dsh-context-milvus`（或工具未注册） | DSH 宿主默认 grep 搜索          |
| **R** | `hybridMode: false`              | 纯向量 dense-only（最接近朴素 RAG） |
| **P** | `hybridMode: true`（默认）           | BM25 + 向量 RRF（插件完整能力）     |

诚实性标注：Plan 1（离线检索）的 R 组是「固定 256 token 窗口 + cosine」；Agent 层的 R 组用插件 `hybridMode=false`，仍走 **AST 分块**，与 Plan 1 的 R 不完全等价。报告结论应避免把两层 R 混为一谈，Agent 层的减法归因是 `P − R` = BM25/RRF 增量（分块能力被抵消）。

## 3. 参考实现 `scripts/eval/agent/drivers/dsh.mjs`

DSH-agnostic 部分（git checkout、gold patch 判定、JSON 输出）可直接使用；DSH 集成缝 `runDshAgent` 见第 4 节。

```js
// 真实 DSH driver：DSH-agnostic 部分完整可跑；runDshAgent 为宿主集成缝。
import { mkdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { loadTasks } from '../lib/tasks.mjs'

const pexec = promisify(execFile)
const args = process.argv.slice(2)
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const taskId = getArg('--task', '')
const group = getArg('--group', 'G')
const root = getArg('--root', process.cwd())

// 1. 找到任务定义（--tasks 文件路径可用 DSH_DRIVER_TASKS 环境变量传入）
const tasksFile = process.env.DSH_DRIVER_TASKS ?? path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'sample-tasks.json')
const tasks = await loadTasks(tasksFile)
const task = tasks.find((t) => t.id === taskId)
if (!task) throw new Error(`task not found: ${taskId}`)

const started = Date.now()
const ws = path.join(root, taskId)

// 2. 准备 workspace：checkout base commit（用 git worktree，避免污染克隆）
await pexec('git', ['clone', '--quiet', task.repo, ws]).catch(() => {})
await pexec('git', ['checkout', '--quiet', task.baseCommit], { cwd: ws })

// 3. 按 group 生成 DSH 配置（写入 ws 下临时配置）
const pluginConfig = group === 'G'
  ? {}
  : {
      hybridMode: group === 'P',
      indexRoot: ws,
      milvusAddress: process.env.MILVUS_ADDRESS ?? 'localhost:19530',
      embeddingEndpoint: process.env.EMBEDDING_ENDPOINT ?? 'http://localhost:11434/api/embed',
      embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
      telemetryEnabled: process.env.DSH_TELEMETRY === '1',
    }
await writeFile(path.join(ws, '.dsh-eval-config.json'), JSON.stringify({ plugin: pluginConfig }, null, 2), 'utf-8')

// 4. 运行 DSH agent（宿主集成缝）
const { passed, tokens, toolCalls } = await runDshAgent({
  task, group, ws, pluginConfig,
  issue: task.goldPatch, // 实际应传 issue 描述文本；goldPatch 仅用于判定
})

// 5. 判定：agent 产出 workspace 上跑 testCommand
let testPassed = false
try {
  const { code } = await pexec(task.testCommand, { cwd: ws, shell: true, timeout: 10 * 60 * 1000 })
  testPassed = code === 0
} catch { testPassed = false }

const durationMs = Date.now() - started
process.stdout.write(JSON.stringify({ passed: passed ?? testPassed, tokens, toolCalls, durationMs }) + '\n')
await rm(ws, { recursive: true, force: true }).catch(() => {})
```

## 4. DSH 集成缝 `runDshAgent`

DSH 宿主如何以 headless 方式启动一个 agent 会话、如何取 token/工具调用计数，**在不同宿主版本间无统一 API**（仓库内仅能确认 `exec.agent.session.header.cwd` 可访问）。按可用性从高到低给三个落地选项：

**选项 A — DSH CLI（若宿主提供 headless 命令）**

```js
async function runDshAgent({ task, group, ws, pluginConfig, issue }) {
  const cmd = process.env.DSH_AGENT_CMD ?? 'dsh'
  const out = await pexec(cmd, ['agent', 'run', '--task', issue, '--cwd', ws, '--config', path.join(ws, '.dsh-eval-config.json')], { timeout: 30 * 60 * 1000 })
  const parsed = JSON.parse(out.stdout) // 依宿主输出格式适配
  return { passed: parsed.passed, tokens: parsed.tokens ?? null, toolCalls: parsed.toolCalls ?? null }
}
```

验收标准：`parsed.tokens/toolCalls` 与宿主会话页数值一致；无则输出 `null`。

**选项 B — DSH SDK（`@deepseek-ai/*`）**
若宿主提供 agent 运行时 SDK（如 `@deepseek-ai/dsh-llm` 之上的 session 编排），在 `runDshAgent` 内以编程方式建会话、注入工具集（G 不注入插件、R/P 注入对应 hybridMode 的插件工具）、结束后从 session 对象读 token 统计。代码结构与选项 A 相同，只是 `pexec` 换成 SDK 调用。

**选项 C — 手工编排（兜底，最诚实）**

1. 在 DSH App 里按第 2 节配置分别加载插件（G 不加载）；
2. 逐个任务手动发起会话；
3. `tokens/toolCalls` 从 DSH 会话用量页面记录，或开启插件遥测（`telemetryEnabled: true`）用 `npm run eval:telemetry` 取 `search_code` 侧的用量作近似；
4. driver 只负责 checkout 与 `testCommand` 判定，`runDshAgent` 直接从环境变量读 `EVAL_PASSED` / `EVAL_TOKENS` 注入结果。

无论哪个选项：**报告中的 tokens/toolCalls 缺失时必须输出** **`null`，不得伪造**；统计层已对 NaN p 值兜底（Holm 按 p=1 处理）。

## 5. 运行方式

```bash
# 1) 构建插件
npm run build

# 2) 准备 SWE-bench 风格任务集 real-tasks.json（见第 6 节）

# 3) 用真实 driver 跑（k=3 次/组/任务，24h 量级，建议低并发分批）
DSH_DRIVER_TASKS=./real-tasks.json \
node scripts/eval/agent/run.mjs \
  --driver scripts/eval/agent/drivers/dsh.mjs \
  --tasks real-tasks.json \
  --root /tmp/eval-ws \
  --k 3

# 4) 单点冒烟（先验证单个 task×group 的 driver 输出合法）
node scripts/eval/agent/drivers/dsh.mjs --task task-001 --group P --root /tmp/eval-ws
```

## 6. SWE-bench 风格任务集要求

`real-tasks.json` 每项：

```json
{
  "id": "repo-issue-123",
  "repo": "https://github.com/org/repo.git",
  "baseCommit": "父提交 SHA（修复前）",
  "goldPatch": "issue 描述 / 复现步骤（传给 agent 的文本）",
  "testCommand": "判定命令，如 `npm test -- --filter fix-123`"
}
```

* `baseCommit` 必须可 checkout；`testCommand` 必须在 base 上失败、在 gold 修复后通过（否则该任务不可判定，应剔除）。

* 数量建议 30–60 个；每组每任务 k=3 时总运行数 = 任务数 × 3 × 3，预算内取舍。

## 7. 与既有代码的关系

* 复用 `run-agent.mjs` 的 spawn 契约，driver 只需满足第 1 节 CLI/输出格式。

* `simulated.mjs` 保留作 CI/无宿主环境的回归 driver；`dsh.mjs` 是产物 driver。

* 指标口径（pass@k 定义、Friedman/Nemenyi/McNemar/Holm、Bootstrap CI）与 [Plan 2](file:///workspace/docs/superpowers/plans/2026-09-05-agent-eval.md) 完全一致，无需改动 harness。

