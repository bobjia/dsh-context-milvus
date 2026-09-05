# 插件原生埋点 Telemetry 实现计划（Plan 3 / 3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为插件加入 opt-in 本地遥测：`search_code` / `index_code` / `index_status` 每次执行写一行 JSONL（默认关闭、不采源代码内容），并提供 `scripts/eval/telemetry/` 分析脚本做描述性统计 + Bootstrap CI + 相关性，支撑 spec 第三层「实际运行观测」。

**Architecture:** 新增 `src/telemetry.ts`（`createTelemetry` 返回 `{ log, flush }`，log 内实时解析配置决定是否落盘，写盘排队异步化、失败静默）；`config.ts` / `index.ts` 增加 `telemetryEnabled`（默认 false）、`telemetryFile` 两个配置；`tools.ts` 三个 execute 埋点（不改变返回结构）。分析侧复用 `scripts/eval/retrieval/lib/stats.mjs` 的 `mulberry32`，纯函数 `lib/analyze.mjs` + `node:test` 单测，`run.mjs` 聚合输出报告。

**Tech Stack:** TypeScript（`src/`，jest 单测于 `test/`）、Node ESM `.mjs`（分析脚本，`node:test`）。不新增 npm 依赖。

---

## 文件结构

```
src/plugins/dsh-context-milvus/
  telemetry.ts          # createTelemetry / sanitizeQuery
  config.ts             # + telemetryEnabled / telemetryFile（Modify）
  index.ts              # + schema 字段（Modify）
  tools.ts              # 三处 execute 埋点（Modify）
test/
  telemetry.spec.ts     # jest 单测
scripts/eval/telemetry/
  lib/analyze.mjs       # parseJsonl / groupByTool / quartiles / bootstrapCi / pearson
  lib/analyze.test.mjs  # node:test 单测
  run.mjs               # CLI 聚合 + 报告
  output/report.md      # 生成物（gitignore）
```

`package.json` 新增脚本：`"test:eval-telemetry": "node --test scripts/eval/telemetry/lib/*.test.mjs"`、`"eval:telemetry": "node scripts/eval/telemetry/run.mjs"`。

---

## Task 1: telemetry.ts — 遥测写入模块

**Files:**
- Create: `src/plugins/dsh-context-milvus/telemetry.ts`
- Test: `test/telemetry.spec.ts`

- [ ] **Step 1: 写失败测试**

`test/telemetry.spec.ts`（jest，风格对齐 `test/code-relations.spec.ts`）：

```ts
import { describe, expect, test } from '@jest/globals'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

describe('telemetry', () => {
  test('sanitizeQuery strips control chars and truncates', async () => {
    const { sanitizeQuery } = await import('../src/plugins/dsh-context-milvus/telemetry.js')
    expect(sanitizeQuery('a\nb\u0000c')).toBe('a b c')
    expect(sanitizeQuery('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })

  test('createTelemetry disabled writes nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tel-'))
    const file = path.join(dir, 't.jsonl')
    const { createTelemetry } = await import('../src/plugins/dsh-context-milvus/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: false, telemetryFile: file }))
    tel.log({ ts: new Date().toISOString(), tool: 'search_code', query: 'q' })
    await tel.flush()
    await expect(readFile(file, 'utf-8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })

  test('createTelemetry enabled appends JSONL lines', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tel-'))
    const file = path.join(dir, 't.jsonl')
    const { createTelemetry } = await import('../src/plugins/dsh-context-milvus/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: true, telemetryFile: file }))
    tel.log({ ts: '2026-01-01T00:00:00.000Z', tool: 'search_code', query: 'auth', resultCount: 3 })
    tel.log({ ts: '2026-01-01T00:00:01.000Z', tool: 'index_status', totalFiles: 10 })
    await tel.flush()
    const text = await readFile(file, 'utf-8')
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).tool).toBe('search_code')
    expect(JSON.parse(lines[1]).tool).toBe('index_status')
    await rm(dir, { recursive: true, force: true })
  })

  test('log failures are swallowed (bad dir)', async () => {
    const { createTelemetry } = await import('../src/plugins/dsh-context-milvus/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: true, telemetryFile: '/nonexistent-dir-xyz/t.jsonl' }))
    tel.log({ ts: new Date().toISOString(), tool: 'search_code', query: 'q' })
    await tel.flush()
    expect(true).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/telemetry.spec.ts`
Expected: FAIL（找不到 `../src/plugins/dsh-context-milvus/telemetry.js`）

- [ ] **Step 3: 实现**

`src/plugins/dsh-context-milvus/telemetry.ts`：

```ts
/**
 * 本地遥测：工具执行指标写入 JSONL（默认关闭，opt-in）。
 * 只记录查询文本与统计量，不采集源代码内容。
 */
import { mkdir, appendFile } from 'node:fs/promises'
import * as path from 'node:path'

export interface TelemetryEntry {
  ts: string
  tool: string
  [key: string]: unknown
}

export interface TelemetryConfig {
  telemetryEnabled: boolean
  telemetryFile: string
}

export interface Telemetry {
  log: (entry: TelemetryEntry) => void
  flush: () => Promise<void>
}

/** 配置快照每次调用实时解析，GUI 修改后无需重载即生效。 */
export function createTelemetry(resolveConfig: () => TelemetryConfig): Telemetry {
  let queue: Promise<void> = Promise.resolve()
  return {
    log(entry) {
      const cfg = resolveConfig()
      if (!cfg.telemetryEnabled || !cfg.telemetryFile) return
      const line = JSON.stringify(entry)
      queue = queue.then(async () => {
        try {
          await mkdir(path.dirname(cfg.telemetryFile), { recursive: true })
          await appendFile(cfg.telemetryFile, line + '\n', 'utf-8')
        } catch {
          // 遥测失败不影响业务执行
        }
      })
    },
    flush: () => queue,
  }
}

/** 查询文本脱敏：去控制字符 + 截断，防止日志注入与超长条目。 */
export function sanitizeQuery(q: unknown): string {
  return String(q ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 200)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --experimental-vm-modules node_modules/.bin/jest test/telemetry.spec.ts`
Expected: PASS（4 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add src/plugins/dsh-context-milvus/telemetry.ts test/telemetry.spec.ts
git commit -m "feat(telemetry): opt-in local JSONL telemetry writer"
```

---

## Task 2: config.ts + index.ts — 遥测配置

**Files:**
- Modify: `src/plugins/dsh-context-milvus/config.ts`
- Modify: `src/plugins/dsh-context-milvus/index.ts`

- [ ] **Step 1: config.ts 增加字段**

在 `CordisConfig` 接口（`merkleFilePath` 附近）加：

```ts
  /** 启用本地遥测（JSONL，默认关闭） */
  telemetryEnabled?: boolean
  /** 遥测 JSONL 文件路径（留空用默认 ~/.milvus-index/telemetry.jsonl） */
  telemetryFile?: string
```

在 `PluginConfig` 接口（`merkleFilePath: string` 之后）加：

```ts
  telemetryEnabled: boolean
  telemetryFile: string
```

在 `getConfig` 返回对象（`merkleFilePath: ...` 之后）加：

```ts
    telemetryEnabled: overrides?.telemetryEnabled ?? false,
    telemetryFile: overrides?.telemetryFile ?? path.join(os.homedir(), '.milvus-index', 'telemetry.jsonl'),
```

注：`config.ts` 已 `import * as path from 'node:path'` 与 `import * as os from 'node:os'`，无需新增 import。

- [ ] **Step 2: index.ts schema 增加字段**

在 `Config` schema 的 `planRoot` 字段（`index.ts` 末尾）之后加：

```ts
  /** 启用本地遥测统计（写入 JSONL，默认关闭） */
  telemetryEnabled: z.boolean()
    .default(false)
    .description('启用本地遥测统计（search_code/index_code/index_status 写入 JSONL，默认关闭）'),

  /** 遥测 JSONL 文件路径 */
  telemetryFile: z.string()
    .default('')
    .description('遥测 JSONL 文件路径（留空使用默认 ~/.milvus-index/telemetry.jsonl）'),
```

- [ ] **Step 3: 构建验证**

Run: `npm run build`
Expected: PASS（tsc 无类型错误；`CordisConfig`/`PluginConfig`/`Config` 三处一致）

- [ ] **Step 4: 提交**

```bash
git add src/plugins/dsh-context-milvus/config.ts src/plugins/dsh-context-milvus/index.ts
git commit -m "feat(telemetry): add telemetryEnabled/telemetryFile config"
```

---

## Task 3: tools.ts — 三处 execute 埋点

**Files:**
- Modify: `src/plugins/dsh-context-milvus/tools.ts`

- [ ] **Step 1: 引入 telemetry**

在 `tools.ts` 顶部 import 区（现有 `./import-resolver.js` 等之后）加：

```ts
import { createTelemetry, sanitizeQuery } from './telemetry.js'
```

- [ ] **Step 2: 在 registerTools 开头创建 logger**

`registerTools` 函数体第一行（`ctx.tools.register` 之前）加：

```ts
  // 本地遥测（opt-in）：每次调用实时解析配置
  const telemetry = createTelemetry(() => {
    const c = resolveConfig()
    return { telemetryEnabled: c.telemetryEnabled, telemetryFile: c.telemetryFile }
  })
```

- [ ] **Step 3: search_code 埋点**

把 `search_code` 的 `execute`（[tools.ts:167-176](file:///workspace/src/plugins/dsh-context-milvus/tools.ts#L167-L176)）改为：

```ts
      async execute(params: any, exec?: any) {
        const started = Date.now()
        const query = params.query
        const topK = params.topK ?? 5
        // Use explicit path, or the current session's workspace directory
        const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
        const path = params.path ?? sessionCwd ?? undefined

        await milvus.ensureCollection()
        const results = await milvus.search(query, topK, path)
        telemetry.log({
          ts: new Date().toISOString(),
          tool: 'search_code',
          query: sanitizeQuery(query),
          topK,
          path: path ?? '',
          resultCount: results.length,
          topScore: results.length > 0 ? results[0].score : null,
          durationMs: Date.now() - started,
        })
        return results
      },
```

- [ ] **Step 4: index_code 埋点**

把 `index_code` 的 `execute` 结尾（`return { ...codeResult, adrFilesIndexed, adrChunksIndexed }` 之前，即 [tools.ts:283](file:///workspace/src/plugins/dsh-context-milvus/tools.ts#L283) 处）加：

```ts
        telemetry.log({
          ts: new Date().toISOString(),
          tool: 'index_code',
          mode,
          path: effectiveConfig.indexRoot,
          filesIndexed: codeResult.filesIndexed,
          chunksIndexed: codeResult.chunksIndexed,
          filesSkipped: codeResult.filesSkipped,
          durationMs: codeResult.durationMs,
        })

        return {
          ...codeResult,
          adrFilesIndexed,
          adrChunksIndexed,
        }
```

- [ ] **Step 5: index_status 埋点**

把 `index_status` 的 `execute` 结尾（`return v` 之前，即 [tools.ts:373](file:///workspace/src/plugins/dsh-context-milvus/tools.ts#L373) 处）加：

```ts
        telemetry.log({
          ts: new Date().toISOString(),
          tool: 'index_status',
          path: effectiveConfig.indexRoot,
          totalFiles: v.totalFiles,
          totalChunks: v.totalChunks,
          lastIndexed: v.lastIndexed ?? '',
        })

        return v
```

- [ ] **Step 6: 构建验证**

Run: `npm run build`
Expected: PASS（tsc 无类型错误）

- [ ] **Step 7: 提交**

```bash
git add src/plugins/dsh-context-milvus/tools.ts
git commit -m "feat(telemetry): instrument search_code/index_code/index_status"
```

---

## Task 4: 分析脚本 — 描述统计 + Bootstrap CI + 相关性

**Files:**
- Create: `scripts/eval/telemetry/lib/analyze.mjs`
- Create: `scripts/eval/telemetry/lib/analyze.test.mjs`
- Create: `scripts/eval/telemetry/run.mjs`
- Modify: `package.json`、`.gitignore`

- [ ] **Step 1: 写失败测试**

`scripts/eval/telemetry/lib/analyze.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonl, groupByTool, quartiles, bootstrapCi, pearson } from './analyze.mjs'
import { mulberry32 } from '../../retrieval/lib/stats.mjs'

test('parseJsonl skips malformed lines', () => {
  const es = parseJsonl('{"tool":"a"}\nnot json\n\n{"tool":"b"}\n')
  assert.equal(es.length, 2)
  assert.equal(es[0].tool, 'a')
})

test('groupByTool groups entries by tool', () => {
  const g = groupByTool([{ tool: 'a' }, { tool: 'b' }, { tool: 'a' }])
  assert.equal(g.a.length, 2)
  assert.equal(g.b.length, 1)
})

test('quartiles median of odd array is middle', () => {
  assert.equal(quartiles([3, 1, 2]).median, 2)
})

test('bootstrapCi contains the sample mean', () => {
  const rng = mulberry32(9)
  const { mean, lo, hi } = bootstrapCi([1, 2, 3, 4, 5], { nBoot: 500, rng })
  assert.equal(mean, 3)
  assert.ok(lo <= mean && mean <= hi)
})

test('pearson is 1 for perfectly correlated data', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [4, 5, 6]) - 1) < 1e-9)
})

test('pearson is ~0 for uncorrelated data', () => {
  assert.ok(Math.abs(pearson([1, 2, 3], [1, 1, 1])) < 1e-9)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/telemetry/lib/analyze.test.mjs`
Expected: FAIL（找不到 `./analyze.mjs`）

- [ ] **Step 3: 实现 analyze.mjs**

`scripts/eval/telemetry/lib/analyze.mjs`：

```js
// 遥测 JSONL 聚合：解析、分组、描述统计、Bootstrap CI、Pearson 相关。

export function parseJsonl(text) {
  const entries = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      // 跳过畸形行
    }
  }
  return entries
}

export function groupByTool(entries) {
  const out = {}
  for (const e of entries) {
    const k = e.tool ?? 'unknown'
    ;(out[k] ??= []).push(e)
  }
  return out
}

export function quartiles(values) {
  const s = [...values].sort((a, b) => a - b)
  if (s.length === 0) return { min: NaN, q1: NaN, median: NaN, q3: NaN, max: NaN }
  const q = (p) => {
    const pos = (s.length - 1) * p
    const lo = Math.floor(pos)
    const hi = Math.ceil(pos)
    return (s[lo] + s[hi]) / 2
  }
  return { min: s[0], q1: q(0.25), median: q(0.5), q3: q(0.75), max: s[s.length - 1] }
}

export function bootstrapCi(values, { nBoot = 1000, alpha = 0.05, rng } = {}) {
  const n = values.length
  if (n === 0) return { mean: NaN, lo: NaN, hi: NaN, n: 0 }
  const draw = rng || Math.random
  const stats = new Array(nBoot)
  for (let b = 0; b < nBoot; b++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += values[Math.floor(draw() * n)]
    stats[b] = sum / n
  }
  stats.sort((a, b) => a - b)
  return {
    mean: values.reduce((s, v) => s + v, 0) / n,
    lo: stats[Math.floor((alpha / 2) * nBoot)],
    hi: stats[Math.ceil((1 - alpha / 2) * nBoot) - 1],
    n,
  }
}

export function pearson(x, y) {
  const n = Math.min(x.length, y.length)
  if (n === 0) return NaN
  const mx = x.slice(0, n).reduce((s, v) => s + v, 0) / n
  const my = y.slice(0, n).reduce((s, v) => s + v, 0) / n
  let num = 0, dx = 0, dy = 0
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my)
    dx += (x[i] - mx) ** 2
    dy += (y[i] - my) ** 2
  }
  if (dx === 0 || dy === 0) return 0
  return num / Math.sqrt(dx * dy)
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/telemetry/lib/analyze.test.mjs`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: 实现 run.mjs**

`scripts/eval/telemetry/run.mjs`：

```js
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseJsonl, groupByTool, quartiles, bootstrapCi, pearson } from './lib/analyze.mjs'
import { mulberry32 } from '../retrieval/lib/stats.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const getArg = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
const file = getArg('--file', path.join(os.homedir(), '.milvus-index', 'telemetry.jsonl'))

const text = await readFile(file, 'utf-8').catch(() => '')
const entries = parseJsonl(text)
const byTool = groupByTool(entries)
const rng = mulberry32(11)

const NUMERIC = {
  search_code: ['resultCount', 'topScore', 'durationMs'],
  index_code: ['filesIndexed', 'chunksIndexed', 'filesSkipped', 'durationMs'],
  index_status: ['totalFiles', 'totalChunks'],
}

const lines = ['# 插件实际运行遥测报告', '']
lines.push(`- 数据来源: ${file}`)
lines.push(`- 总条目数: ${entries.length}`)
lines.push('')
lines.push('## 按工具统计', '')
lines.push('| 工具 | 条目数 |', '|---|---|')
for (const [tool, es] of Object.entries(byTool)) {
  lines.push(`| ${tool} | ${es.length} |`)
  for (const field of NUMERIC[tool] ?? []) {
    const vals = es.map((e) => Number(e[field])).filter((v) => Number.isFinite(v))
    if (vals.length === 0) continue
    const q = quartiles(vals)
    const ci = bootstrapCi(vals, { nBoot: 1000, rng })
    lines.push(`  - ${field}: n=${vals.length}, 中位数=${q.median.toFixed(1)}, IQR=[${q.q1.toFixed(1)}, ${q.q3.toFixed(1)}], 均值=${ci.mean.toFixed(1)} (95% CI [${ci.lo.toFixed(1)}, ${ci.hi.toFixed(1)}])`)
  }
}

// 相关性：search_code 中 query 长度 vs resultCount / topScore
const searches = byTool.search_code ?? []
if (searches.length >= 3) {
  const qlen = searches.map((e) => String(e.query ?? '').length)
  const rc = searches.map((e) => Number(e.resultCount)).filter((v) => Number.isFinite(v))
  const ts = searches.map((e) => Number(e.topScore)).filter((v) => Number.isFinite(v))
  lines.push('')
  lines.push('## 相关性（search_code）', '')
  lines.push(`- query 长度 vs resultCount: r=${pearson(qlen.slice(0, rc.length), rc).toFixed(3)}`)
  lines.push(`- query 长度 vs topScore: r=${pearson(qlen.slice(0, ts.length), ts).toFixed(3)}`)
}
lines.push('')

await mkdir(path.join(__dirname, 'output'), { recursive: true })
const reportPath = path.join(__dirname, 'output', 'report.md')
await writeFile(reportPath, lines.join('\n'), 'utf-8')
console.log(lines.join('\n'))
console.log(`Report written to ${reportPath}`)
```

- [ ] **Step 6: package.json 脚本 + gitignore**

`package.json` 的 `scripts` 加入：

```json
"test:eval-telemetry": "node --test scripts/eval/telemetry/lib/*.test.mjs",
"eval:telemetry": "node scripts/eval/telemetry/run.mjs"
```

`.gitignore` 追加：

```
scripts/eval/telemetry/output/
```

- [ ] **Step 7: 冒烟验证 run.mjs**

Run: `node scripts/eval/telemetry/run.mjs --file /nonexistent.jsonl`
Expected：打印报告（总条目 0、无工具分组），末尾 `Report written to .../output/report.md`，exit 0。

- [ ] **Step 8: 提交**

```bash
git add scripts/eval/telemetry package.json .gitignore
git commit -m "feat(eval-telemetry): telemetry aggregation and report script"
```

---

## Task 5: 收口 — 构建 + 全部测试

**Files:**
- Modify: 无新增

- [ ] **Step 1: 构建**

Run: `npm run build`
Expected: PASS

- [ ] **Step 2: 全部测试**

Run: `npm run test:eval-telemetry && npm run test:eval && npm run test:eval-agent && npm test`
Expected: PASS（analyze 6 + retrieval 14 + agent 16 + jest 套件 231+4=235 全过）

- [ ] **Step 3: 提交（如有修复）**

```bash
git add -A scripts/eval/telemetry src test
git commit -m "test(eval-telemetry): final verification pass"
```

---

## Self-Review

**Spec 覆盖**：Layer 3「插件原生埋点」全部落入 Task 1–5（search_code/index_code/index_status 埋点 + 描述统计/Bootstrap CI/相关性 + 隐私约定默认关、不采源码）。宿主级遥测（token/工具调用计数）已在 spec 标注「需 DSH 暴露，待确认」，不在本计划。

**占位符扫描**：无 TBD/TODO；所有代码完整。

**类型一致性**：`createTelemetry(() => ({ telemetryEnabled, telemetryFile }))` 与 `TelemetryConfig` 一致；`PluginConfig` 新增字段名在 config.ts/tools.ts 一致；`codeResult.filesIndexed/chunksIndexed/filesSkipped/durationMs` 与 `IndexResult` 及 index_code output schema 一致；`v.totalFiles/totalChunks/lastIndexed` 与 index_status output schema 一致。

**注意事项**：`tools.ts` 中 `index_code` 的 `codeResult` 是 `runIndex` 的返回（含 `durationMs`）；`index_status` 的 `v` 是 `status as any`，`lastIndexed` 可能为 `undefined`，已用 `?? ''` 兜底。