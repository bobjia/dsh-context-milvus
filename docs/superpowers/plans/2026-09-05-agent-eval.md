# 端到端 Agent 评测 Harness 实现计划（Plan 2 / 3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建可复跑的端到端 Agent 评测 harness：SWE-bench 风格任务集 × 三组检索策略 × k 次运行，产出 pass 率、token/工具调用/耗时指标 + Friedman/Nemenyi/McNemar/Holm 统计 + Markdown 报告。

**Architecture:** 纯函数模块（`tasks` / `stats-agent` / `aggregate`）用 Node ESM + 内置 `node:test` 单测；`run-agent.mjs` 通过子进程调用**可插拔 driver**（CLI 契约：stdout 输出一行 JSON `{passed,tokens,toolCalls,durationMs}`）；`drivers/simulated.mjs` 提供确定性参考 driver（不依赖真实 DSH），真实 DSH driver 按同一契约接入即可。`run.mjs` 编排：task × group × k → 聚合 → 统计 → 报告。复用 `scripts/eval/retrieval/lib/stats.mjs`（wilcoxon/bootstrap/cliffsDelta/mulberry32）。

**Tech Stack:** Node.js ESM（`.mjs`）、内置 `node:test`、`node:child_process` spawn。不新增 npm 依赖。

---

## 文件结构

```
scripts/eval/agent/
  lib/tasks.mjs           # 任务集加载 + 校验
  lib/tasks.test.mjs
  lib/stats-agent.mjs     # friedman / nemenyiCD / mcnemar / holm / chi2Survival
  lib/stats-agent.test.mjs
  lib/aggregate.mjs       # taskSuccessFraction / medianOfRun
  lib/aggregate.test.mjs
  lib/run-agent.mjs       # driver 子进程调用契约
  lib/run-agent.test.mjs  # 用 simulated driver 验证
  drivers/simulated.mjs   # 确定性参考 driver
  sample-tasks.json       # 示例任务集（8 个任务）
  run.mjs                 # 编排器 + 报告生成
  output/report.md        # 生成物（gitignore 已覆盖 scripts/eval/retrieval/output/，需追加 agent 的）
```

`package.json` 新增脚本：`"test:eval-agent": "node --test scripts/eval/agent/lib/*.test.mjs"`。

---

## Task 1: tasks.mjs — 任务集加载

**Files:**
- Create: `scripts/eval/agent/lib/tasks.mjs`
- Create: `scripts/eval/agent/sample-tasks.json`
- Test: `scripts/eval/agent/lib/tasks.test.mjs`

- [ ] **Step 1: 写失败测试**

`scripts/eval/agent/lib/tasks.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadTasks } from './tasks.mjs'

test('loadTasks parses task list', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tsk-'))
  const fp = path.join(dir, 't.json')
  await writeFile(fp, JSON.stringify({ tasks: [{ id: 't1', repo: 'a/b', baseCommit: 'x', goldPatch: 'p', testCommand: 'npm test' }] }))
  const ts = await loadTasks(fp)
  assert.equal(ts.length, 1)
  assert.equal(ts[0].id, 't1')
  await rm(dir, { recursive: true, force: true })
})

test('loadTasks rejects missing testCommand', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'tsk-'))
  const fp = path.join(dir, 'bad.json')
  await writeFile(fp, JSON.stringify({ tasks: [{ id: 't1', repo: 'a/b', baseCommit: 'x', goldPatch: 'p' }] }))
  await assert.rejects(() => loadTasks(fp), /testCommand/)
  await rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/agent/lib/tasks.test.mjs`
Expected: FAIL（找不到 `./tasks.mjs`）

- [ ] **Step 3: 实现**

`scripts/eval/agent/lib/tasks.mjs`：

```js
import { readFile } from 'node:fs/promises'

export async function loadTasks(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data.tasks)) throw new Error('task set must have a "tasks" array')
  for (const t of data.tasks) {
    if (!t.id || !t.repo || !t.baseCommit || !t.goldPatch || !t.testCommand) {
      throw new Error('each task needs { id, repo, baseCommit, goldPatch, testCommand }')
    }
  }
  return data.tasks
}
```

`scripts/eval/agent/sample-tasks.json`：

```json
{
  "tasks": [
    { "id": "task-001", "repo": "acme/example", "baseCommit": "abc123", "goldPatch": "diff --git a/src/a.ts b/src/a.ts", "testCommand": "npm test" },
    { "id": "task-002", "repo": "acme/example", "baseCommit": "abc124", "goldPatch": "diff --git a/src/b.ts b/src/b.ts", "testCommand": "npm test" },
    { "id": "task-003", "repo": "acme/example", "baseCommit": "abc125", "goldPatch": "diff --git a/src/c.ts b/src/c.ts", "testCommand": "npm test" },
    { "id": "task-004", "repo": "acme/example", "baseCommit": "abc126", "goldPatch": "diff --git a/src/d.ts b/src/d.ts", "testCommand": "npm test" },
    { "id": "task-005", "repo": "acme/example", "baseCommit": "abc127", "goldPatch": "diff --git a/src/e.ts b/src/e.ts", "testCommand": "npm test" },
    { "id": "task-006", "repo": "acme/example", "baseCommit": "abc128", "goldPatch": "diff --git a/src/f.ts b/src/f.ts", "testCommand": "npm test" },
    { "id": "task-007", "repo": "acme/example", "baseCommit": "abc129", "goldPatch": "diff --git a/src/g.ts b/src/g.ts", "testCommand": "npm test" },
    { "id": "task-008", "repo": "acme/example", "baseCommit": "abc130", "goldPatch": "diff --git a/src/h.ts b/src/h.ts", "testCommand": "npm test" }
  ]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/agent/lib/tasks.test.mjs`
Expected: PASS（2 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/agent/lib/tasks.mjs scripts/eval/agent/lib/tasks.test.mjs scripts/eval/agent/sample-tasks.json
git commit -m "feat(eval-agent): task set loader and sample tasks"
```

---

## Task 2: stats-agent.mjs — Friedman / Nemenyi / McNemar / Holm

**Files:**
- Create: `scripts/eval/agent/lib/stats-agent.mjs`
- Test: `scripts/eval/agent/lib/stats-agent.test.mjs`

- [ ] **Step 1: 写失败测试**

`scripts/eval/agent/lib/stats-agent.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friedman, nemenyiCD, mcnemar, holm, chi2Survival } from './stats-agent.mjs'

test('chi2Survival df=1 is ~0.05 at x=3.841', () => {
  assert.ok(Math.abs(chi2Survival(3.841, 1) - 0.05) < 0.01)
})

test('chi2Survival df=2 is ~0.05 at x=5.991', () => {
  assert.ok(Math.abs(chi2Survival(5.991, 2) - 0.05) < 0.01)
})

test('friedman p is ~1 when all groups identical per block', () => {
  const matrix = [[0.5, 0.5, 0.5], [1, 1, 1], [0, 0, 0], [0.7, 0.7, 0.7], [0.3, 0.3, 0.3]]
  const { p } = friedman(matrix)
  assert.ok(Math.abs(p - 1) < 1e-9)
})

test('friedman p is small for consistent group separation', () => {
  const matrix = Array.from({ length: 12 }, (_, i) => [0.1 + i * 0.01, 0.5 + i * 0.01, 0.9 + i * 0.01])
  const { p } = friedman(matrix)
  assert.ok(p < 0.01)
})

test('nemenyiCD is positive and scales with group count', () => {
  const cd3 = nemenyiCD(20, 3)
  const cd4 = nemenyiCD(20, 4)
  assert.ok(cd3 > 0)
  assert.ok(cd4 > cd3)
})

test('mcnemar is significant when b much larger than c', () => {
  const { p } = mcnemar(10, 2)
  assert.ok(p < 0.05)
})

test('mcnemar p is 1 when b equals c', () => {
  const { p } = mcnemar(3, 3)
  assert.ok(p > 0.9)
})

test('holm rejects strong effects and stops at the first weak one', () => {
  const reject = holm([0.01, 0.04, 0.05], 0.05)
  assert.deepEqual(reject, [true, false, false])
})

test('holm rejects all when all p-values are tiny', () => {
  const reject = holm([0.001, 0.002, 0.003], 0.05)
  assert.deepEqual(reject, [true, true, true])
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/agent/lib/stats-agent.test.mjs`
Expected: FAIL（找不到 `./stats-agent.mjs`）

- [ ] **Step 3: 实现**

`scripts/eval/agent/lib/stats-agent.mjs`：

```js
// 三组重复测量的非参数统计：Friedman 主效应 + Nemenyi 事后 + McNemar + Holm 校正。
// chi2 生存函数用不完全伽马函数（NR gammp/gammq 系列 + 连分式）。

function normalCdf(z) {
  const sign = z < 0 ? -1 : 1
  const a = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * a)
  const d = 0.3989422804014327 * Math.exp((-a * a) / 2)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return sign < 0 ? d * poly : 1 - d * poly
}

function logGamma(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}

function gser(a, x) {
  const ITMAX = 100, EPS = 3e-7
  let sum = 1 / a
  let ap = a
  let del = sum
  for (let n = 0; n < ITMAX; n++) {
    ap += 1
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * EPS) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
}

function gcf(a, x) {
  const ITMAX = 100, EPS = 3e-7, FPMIN = 1e-30
  let b = x + 1 - a
  let c = 1 / FPMIN
  let d = 1 / b
  let h = d
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = b + an / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

function gammp(a, x) { return x < a + 1 ? gser(a, x) : 1 - gcf(a, x) }

// 卡方分布生存函数 P(X > x)，df 为自由度。
export function chi2Survival(x, df) {
  if (df === 1) return 2 * (1 - normalCdf(Math.sqrt(x)))
  if (df === 2) return Math.exp(-x / 2)
  return 1 - gammp(df / 2, x / 2)
}

// 配对秩平均（块内并列取平均秩）
function rankWithin(row) {
  const g = row.length
  const sorted = row.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const r = new Array(g)
  let i = 0
  while (i < g) {
    let j = i
    while (j + 1 < g && sorted[j + 1].v === sorted[i].v) j++
    const avg = (i + 1 + j + 1) / 2
    for (let t = i; t <= j; t++) r[sorted[t].i] = avg
    i = j + 1
  }
  return r
}

// Friedman 检验（含并列校正）。matrix: n 行（任务）× g 列（组）。
export function friedman(matrix) {
  const n = matrix.length
  if (n === 0) throw new Error('friedman: empty matrix')
  const g = matrix[0].length
  if (g < 2) throw new Error('friedman: need >= 2 groups')
  const R = new Array(g).fill(0)
  for (const row of matrix) {
    const r = rankWithin(row)
    for (let j = 0; j < g; j++) R[j] += r[j]
  }
  let tieSum = 0
  for (const raw of matrix) {
    const sorted = [...raw].sort((a, b) => a - b)
    let i = 0
    while (i < g) {
      let j = i
      while (j + 1 < g && sorted[j + 1] === sorted[i]) j++
      const t = j - i + 1
      if (t > 1) tieSum += t * t * t - t
      i = j + 1
    }
  }
  const Q = (12 / (n * g * (g + 1))) * R.reduce((s, r) => s + (r - (n * (g + 1)) / 2) ** 2, 0)
  const C1 = 1 - tieSum / (n * g * (g * g - 1))
  const Qcorr = C1 > 0 ? Q / C1 : Q
  const df = g - 1
  return { Q: Qcorr, df, p: chi2Survival(Qcorr, df), rankSums: R, n, g }
}

// Nemenyi 事后检验的临界差 CD（学生化极差表，α=0.05，df=∞）。
const STUDENTIZED_RANGE = { 2: 1.960, 3: 3.314, 4: 3.633, 5: 3.858, 6: 4.030, 7: 4.170, 8: 4.286, 9: 4.387, 10: 4.474 }

export function nemenyiCD(n, g, alpha = 0.05) {
  if (alpha !== 0.05) throw new Error('nemenyiCD: only alpha=0.05 table provided')
  const q = STUDENTIZED_RANGE[g] ?? 3.858
  return q * Math.sqrt((g * (g + 1)) / (12 * n))
}

// McNemar（配对比例，连续性校正）。b = P 成而 X 败，c = X 成而 P 败。
export function mcnemar(b, c) {
  const n = b + c
  if (n === 0) return { chi2: 0, p: NaN, n }
  const chi2 = (Math.abs(b - c) - 1) ** 2 / n
  return { chi2, p: chi2Survival(chi2, 1), n }
}

// Holm 序贯 Bonferroni 校正。返回与输入同序的拒绝布尔数组。
export function holm(pValues, alpha = 0.05) {
  const m = pValues.length
  const idx = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const reject = new Array(m).fill(false)
  for (let k = 0; k < m; k++) {
    if (idx[k].p <= alpha / (m - k)) reject[idx[k].i] = true
    else break
  }
  return reject
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/agent/lib/stats-agent.test.mjs`
Expected: PASS（9 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/agent/lib/stats-agent.mjs scripts/eval/agent/lib/stats-agent.test.mjs
git commit -m "feat(eval-agent): Friedman/Nemenyi/McNemar/Holm stats"
```

---

## Task 3: aggregate.mjs — 运行聚合

**Files:**
- Create: `scripts/eval/agent/lib/aggregate.mjs`
- Test: `scripts/eval/agent/lib/aggregate.test.mjs`

- [ ] **Step 1: 写失败测试**

`scripts/eval/agent/lib/aggregate.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { taskSuccessFraction, medianOfRun } from './aggregate.mjs'

test('taskSuccessFraction is runs-passed over runs', () => {
  assert.equal(taskSuccessFraction([{ passed: true }, { passed: false }, { passed: true }]), 2 / 3)
  assert.equal(taskSuccessFraction([{ passed: false }]), 0)
})

test('medianOfRun returns median value for odd count', () => {
  assert.equal(medianOfRun([{ tokens: 3 }, { tokens: 1 }, { tokens: 2 }], 'tokens'), 2)
})

test('medianOfRun averages middle two for even count', () => {
  assert.equal(medianOfRun([{ tokens: 4 }, { tokens: 2 }], 'tokens'), 3)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/agent/lib/aggregate.test.mjs`
Expected: FAIL（找不到 `./aggregate.mjs`）

- [ ] **Step 3: 实现**

`scripts/eval/agent/lib/aggregate.mjs`：

```js
// 单任务多运行结果聚合。

export function taskSuccessFraction(runs) {
  return runs.filter((r) => r.passed).length / runs.length
}

export function medianOfRun(runs, field) {
  const vals = runs.map((r) => r[field]).sort((a, b) => a - b)
  const m = Math.floor(vals.length / 2)
  return vals.length % 2 ? vals[m] : (vals[m - 1] + vals[m]) / 2
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/agent/lib/aggregate.test.mjs`
Expected: PASS（3 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/agent/lib/aggregate.mjs scripts/eval/agent/lib/aggregate.test.mjs
git commit -m "feat(eval-agent): run aggregation helpers"
```

---

## Task 4: simulated.mjs — 确定性参考 driver

**Files:**
- Create: `scripts/eval/agent/drivers/simulated.mjs`

- [ ] **Step 1: 实现**

`scripts/eval/agent/drivers/simulated.mjs`：

```js
// 确定性参考 driver：按 (task, group) 种子决定通过率/指标，不依赖真实 DSH。
// 真实 DSH driver 遵循同一 CLI 契约：--task <id> --group <G|R|P> --root <dir>，stdout 输出一行 JSON。
import { mulberry32 } from '../retrieval/lib/stats.mjs'

function djb2(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

const args = process.argv.slice(2)
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const task = getArg('--task', '')
const group = getArg('--group', 'G')
const rng = mulberry32(djb2(task + ':' + group))

const passProb = { G: 0.25, R: 0.5, P: 0.9 }[group] ?? 0.5
const passed = rng() < passProb
const baseTokens = { G: 5200, R: 4100, P: 3100 }[group] ?? 4100
const baseCalls = { G: 18, R: 13, P: 9 }[group] ?? 13
const baseMs = { G: 95000, R: 82000, P: 64000 }[group] ?? 82000
const jitter = () => 0.9 + 0.2 * rng()
const tokens = Math.round(baseTokens * jitter())
const toolCalls = Math.round(baseCalls * jitter())
const durationMs = Math.round(baseMs * jitter())

process.stdout.write(JSON.stringify({ passed, tokens, toolCalls, durationMs }) + '\n')
```

- [ ] **Step 2: 冒烟验证**

Run: `node scripts/eval/agent/drivers/simulated.mjs --task task-001 --group P`
Expected: stdout 一行合法 JSON，如 `{"passed":true,"tokens":3200,"toolCalls":9,"durationMs":66000}`（具体数值由种子决定，但必须是合法 JSON 且字段齐全）

- [ ] **Step 3: 提交**

```bash
git add scripts/eval/agent/drivers/simulated.mjs
git commit -m "feat(eval-agent): deterministic simulated agent driver"
```

---

## Task 5: run-agent.mjs — driver 调用契约

**Files:**
- Create: `scripts/eval/agent/lib/run-agent.mjs`
- Test: `scripts/eval/agent/lib/run-agent.test.mjs`

- [ ] **Step 1: 写失败测试**

`scripts/eval/agent/lib/run-agent.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgentOnce } from './run-agent.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const driver = path.join(__dirname, '..', 'drivers', 'simulated.mjs')

test('runAgentOnce parses driver JSON output', async () => {
  const r = await runAgentOnce({ driver, task: { id: 'task-001' }, group: 'P', root: '/tmp' })
  assert.equal(typeof r.passed, 'boolean')
  assert.ok(Number.isInteger(r.tokens) && r.tokens > 0)
  assert.ok(Number.isInteger(r.toolCalls) && r.toolCalls > 0)
  assert.ok(Number.isInteger(r.durationMs) && r.durationMs > 0)
})

test('runAgentOnce is deterministic for same task+group', async () => {
  const a = await runAgentOnce({ driver, task: { id: 'task-001' }, group: 'G', root: '/tmp' })
  const b = await runAgentOnce({ driver, task: { id: 'task-001' }, group: 'G', root: '/tmp' })
  assert.deepEqual(a, b)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/agent/lib/run-agent.test.mjs`
Expected: FAIL（找不到 `./run-agent.mjs`）

- [ ] **Step 3: 实现**

`scripts/eval/agent/lib/run-agent.mjs`：

```js
import { spawn } from 'node:child_process'

// 调用一次 driver，解析 stdout 末行 JSON：{ passed, tokens, toolCalls, durationMs }。
export function runAgentOnce({ driver, task, group, root }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, '--task', task.id, '--group', group, '--root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`driver exited ${code}: ${out.trim()}`))
      try {
        const line = out.trim().split('\n').pop()
        const parsed = JSON.parse(line)
        if (typeof parsed.passed !== 'boolean' || typeof parsed.tokens !== 'number') {
          throw new Error('missing fields')
        }
        resolve(parsed)
      } catch (e) {
        reject(new Error(`driver bad output: ${out.trim()}`))
      }
    })
  })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/agent/lib/run-agent.test.mjs`
Expected: PASS（2 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/agent/lib/run-agent.mjs scripts/eval/agent/lib/run-agent.test.mjs
git commit -m "feat(eval-agent): agent driver subprocess contract"
```

---

## Task 6: run.mjs — 编排器 + 报告

**Files:**
- Create: `scripts/eval/agent/run.mjs`
- Modify: `package.json`（新增 `test:eval-agent` 脚本）
- Modify: `.gitignore`（追加 `scripts/eval/agent/output/`）

- [ ] **Step 1: 实现编排器**

`scripts/eval/agent/run.mjs`：

```js
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadTasks } from './lib/tasks.mjs'
import { runAgentOnce } from './lib/run-agent.mjs'
import { taskSuccessFraction, medianOfRun } from './lib/aggregate.mjs'
import { friedman, nemenyiCD, mcnemar, holm } from './lib/stats-agent.mjs'
import { wilcoxonSignedRank, bootstrapMeanDiffCi, cliffsDelta, mulberry32 } from '../retrieval/lib/stats.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const driver = getArg('--driver', path.join(__dirname, 'drivers', 'simulated.mjs'))
const tasksFile = getArg('--tasks', path.join(__dirname, 'sample-tasks.json'))
const createdRoot = !args.includes('--root')
const root = getArg('--root', await mkdtemp(path.join(tmpdir(), 'agent-eval-')))
const K = parseInt(getArg('--k', '3'), 10)
const GROUPS = ['G', 'R', 'P']

// 1. 执行：task × group × k
const tasks = await loadTasks(tasksFile)
const results = {}
for (const task of tasks) {
  results[task.id] = {}
  for (const group of GROUPS) {
    const runs = []
    for (let i = 0; i < K; i++) runs.push(await runAgentOnce({ driver, task, group, root }))
    results[task.id][group] = runs
  }
}

// 2. 聚合（逐任务）
const agg = {}
for (const g of GROUPS) agg[g] = { successFrac: [], binary: [], tokens: [], toolCalls: [], durations: [] }
tasks.forEach((task, ti) => {
  for (const g of GROUPS) {
    const runs = results[task.id][g]
    agg[g].successFrac.push(taskSuccessFraction(runs))
    agg[g].binary.push(runs.some((r) => r.passed) ? 1 : 0)
    agg[g].tokens.push(medianOfRun(runs, 'tokens'))
    agg[g].toolCalls.push(medianOfRun(runs, 'toolCalls'))
    agg[g].durations.push(medianOfRun(runs, 'durationMs'))
  }
})

// 3. 统计
const rng = mulberry32(7)
const matrix = tasks.map((_, ti) => GROUPS.map((g) => agg[g].successFrac[ti]))
const f = friedman(matrix)
const cd = nemenyiCD(tasks.length, GROUPS.length)
const nemenyiPairs = {}
for (let i = 0; i < GROUPS.length; i++) {
  for (let j = i + 1; j < GROUPS.length; j++) {
    nemenyiPairs[`${GROUPS[i]} vs ${GROUPS[j]}`] = Math.abs(f.rankSums[i] - f.rankSums[j]) > cd
  }
}
const mc = {}
const wx = {}
for (const other of ['G', 'R']) {
  const b = agg.P.binary.filter((v, i) => v === 1 && agg[other].binary[i] === 0).length
  const c = agg.P.binary.filter((v, i) => v === 0 && agg[other].binary[i] === 1).length
  mc[`P vs ${other}`] = { ...mcnemar(b, c), b, c }
  const w = wilcoxonSignedRank(agg.P.tokens, agg[other].tokens)
  const ci = bootstrapMeanDiffCi(agg.P.tokens, agg[other].tokens, { nBoot: 1000, rng })
  const d = cliffsDelta(agg.P.tokens, agg[other].tokens)
  wx[`P vs ${other}`] = { p: w.p, n: w.n, meanDiff: ci.mean, lo: ci.lo, hi: ci.hi, cliffsDelta: d }
}

// 4. Holm（三次主对比：pass P vs G、pass P vs R、tokens P vs G）
const primary = [
  { key: 'pass P vs G', p: mc['P vs G'].p },
  { key: 'pass P vs R', p: mc['P vs R'].p },
  { key: 'tokens P vs G', p: wx['P vs G'].p },
].map((x) => ({ ...x, p: Number.isNaN(x.p) ? 1 : x.p }))
const holmReject = holm(primary.map((x) => x.p))

// 5. 报告
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length
const lines = ['# 端到端 Agent 评测报告', '']
lines.push(`- 任务数: ${tasks.length}，每组每任务运行次数 k=${K}，driver: ${path.basename(driver)}`)
lines.push('')
lines.push('## 通过率', '')
lines.push('| 组 | 平均通过率 |', '|---|---|')
for (const g of GROUPS) lines.push(`| ${g} | ${(mean(agg[g].successFrac) * 100).toFixed(1)}% |`)
lines.push('')
lines.push(`## Friedman 主效应: p=${f.p.toExponential(2)} (Q=${f.Q.toFixed(2)}, df=${f.df})`)
lines.push(`Nemenyi 临界差 CD=${cd.toFixed(3)}`)
for (const [pair, sig] of Object.entries(nemenyiPairs)) lines.push(`- ${pair}: 秩差 ${Math.abs(f.rankSums[GROUPS.indexOf(pair.split(' ')[0])] - f.rankSums[GROUPS.indexOf(pair.split(' ')[2])]).toFixed(2)} ${sig ? '显著' : '不显著'}`)
lines.push('')
lines.push('## McNemar（配对通过率）', '')
for (const [pair, r] of Object.entries(mc)) {
  lines.push(`- ${pair}: b=${r.b}, c=${r.c}, p=${Number.isNaN(r.p) ? 'n/a' : r.p.toExponential(2)}`)
}
lines.push('')
lines.push('## 配对 Wilcoxon（token/任务）', '')
for (const [pair, r] of Object.entries(wx)) {
  lines.push(`- ${pair}: Δ均值=${r.meanDiff.toFixed(0)} (95% CI [${r.lo.toFixed(0)}, ${r.hi.toFixed(0)}]), p=${Number.isNaN(r.p) ? 'n/a' : r.p.toExponential(2)}, Cliff's Δ=${r.cliffsDelta.toFixed(3)}, n=${r.n}`)
}
lines.push('')
lines.push('## Holm 校正（三次主对比）', '')
primary.forEach((x, i) => lines.push(`- ${x.key}: p=${x.p.toExponential(2)} → ${holmReject[i] ? '拒绝 H0（显著）' : '不拒绝'}`))
lines.push('')

await mkdir(path.join(__dirname, 'output'), { recursive: true })
const reportPath = path.join(__dirname, 'output', 'report.md')
await writeFile(reportPath, lines.join('\n'), 'utf-8')
console.log(lines.join('\n'))
console.log(`Report written to ${reportPath}`)

if (createdRoot) await rm(root, { recursive: true, force: true })
console.log('=== Eval completed successfully ===')
```

- [ ] **Step 2: 新增 npm 脚本**

`package.json` 的 `scripts` 中加入：

```json
"test:eval-agent": "node --test scripts/eval/agent/lib/*.test.mjs"
```

- [ ] **Step 3: gitignore 追加**

`.gitignore` 追加：

```
scripts/eval/agent/output/
```

- [ ] **Step 4: 端到端验证（用 simulated driver，沙箱可跑）**

Run: `node scripts/eval/agent/run.mjs`
Expected：打印完整报告，末尾 `=== Eval completed successfully ===`；`output/report.md` 生成；P 组通过率应高于 G/R 组（simulated 的 passProb 为 G=0.25/R=0.5/P=0.9，8 个任务 × 3 次运行下大概率呈现）。

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/agent/run.mjs package.json .gitignore
git commit -m "feat(eval-agent): agent eval orchestrator and report generator"
```

---

## Task 7: 端到端单测收口

**Files:**
- Modify: 无新增

- [ ] **Step 1: 跑全部 eval-agent 单测**

Run: `npm run test:eval-agent`
Expected: PASS（tasks 2 + stats-agent 9 + aggregate 3 + run-agent 2 = 16 个测试全过）

- [ ] **Step 2: 跑 eval 与既有套件确认无回归**

Run: `npm run test:eval && npm test`
Expected: PASS（14 + 16 + 既有 jest 231 个全过）

- [ ] **Step 3: 提交（如有修复）**

```bash
git add -A scripts/eval/agent
git commit -m "test(eval-agent): wire agent eval unit tests into npm scripts"
```

---

## Self-Review

**Spec 覆盖**：Layer 2（端到端）的「任务集 → 运行协议 k=3 → pass/效率指标 → Friedman/Nemenyi + Wilcoxon/Bootstrap/Cliff's Δ + McNemar + Holm」全部落入 Task 1–7。真实 DSH driver 按契约接入（`--driver <cmd>`），simulated driver 保证沙箱可复跑。

**占位符扫描**：无 TBD/TODO；所有代码块完整可跑。

**类型一致性**：`runAgentOnce` 契约（`{driver, task:{id}, group, root}` → `{passed,tokens,toolCalls,durationMs}`）在 Task 4/5/6 间一致；`stats-agent.mjs` 的 `friedman`/`nemenyiCD`/`mcnemar`/`holm` 返回结构在 run.mjs 中的使用一致；复用 `../retrieval/lib/stats.mjs` 的 `wilcoxonSignedRank`/`bootstrapMeanDiffCi`/`cliffsDelta`/`mulberry32` 与 Plan 1 实现一致。

**已知假设**：Nemenyi 表仅含 α=0.05、df=∞（三组场景标准做法，已在代码注释声明）；Friedman/McNemar 对 p=NaN（无有效配对）时 run.mjs 已按 p=1 兜底进 Holm。