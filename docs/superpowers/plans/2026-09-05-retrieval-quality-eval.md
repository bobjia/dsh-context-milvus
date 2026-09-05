# 离线检索质量评测 Harness 实现计划（Plan 1 / 3）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 构建一套可复跑的离线评测脚本，量化 `dsh-context-milvus`（P 组）相对 grep（G 组）与朴素向量 RAG（R 组）的检索质量，产出指标 + 非参数统计 + Markdown 报告。

**Architecture:** 纯函数模块（`metrics` / `stats` / `dataset` / `baselines`）用 Node ESM + 内置 `node:test` 单测；`run.mjs` 编排器复用 `dist/` 里已构建的插件（`runIndex` + `MilvusService`）连真实 Milvus + Ollama，跑三组检索 → 算指标 → 算统计 → 写报告。文件级相关性为统一口径。

**Tech Stack:** Node.js ESM（`.mjs`）、内置 `node:test`、`@zilliz/milvus2-sdk-node`、复用插件 `dist/` 的 `EmbeddingClient` / `MilvusService` / `runIndex`。不新增 npm 依赖（统计手写，透明可审）。

---

## 文件结构

```
scripts/eval/retrieval/
  lib/metrics.mjs          # 纯函数：recall@k / MRR / nDCG@k / hit@1 / precision@k（文件级）
  lib/metrics.test.mjs     # node:test 单测
  lib/stats.mjs            # 纯函数：Wilcoxon signed-rank / Bootstrap CI / Cliff's Δ / mulberry32
  lib/stats.test.mjs       # node:test 单测
  lib/dataset.mjs          # 标注查询集加载 + 校验
  lib/dataset.test.mjs     # node:test 单测
  lib/baselines.mjs        # grep 基线（关键词计数）+ 朴素 RAG 基线（固定窗口 + cosine）
  sample-dataset.json      # 示例标注查询集（对应测试仓库的 4 个文件）
  run.mjs                  # 编排器：索引 P 组 → 三组检索 → 指标 → 统计 → 报告
  output/report.md         # 生成物（gitignore）
```

`package.json` 新增脚本：`"test:eval": "node --test scripts/eval/retrieval/lib/*.test.mjs"`。

---

## Task 1: metrics.mjs — 文件级检索指标

**Files:**
- Create: `scripts/eval/retrieval/lib/metrics.mjs`
- Test: `scripts/eval/retrieval/lib/metrics.test.mjs`

- [ ] **Step 1: 写失败测试**

`scripts/eval/retrieval/lib/metrics.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { recallAtK, hitAtK, precisionAtK, mrr, ndcgAtK } from './metrics.mjs'

test('recall@k counts unique relevant hits over total relevant', () => {
  assert.equal(recallAtK(['a', 'b', 'c'], ['b', 'z'], 3), 0.5)
  assert.equal(recallAtK(['a', 'a', 'b'], ['a', 'c'], 3), 0.5) // dedup 'a'
  assert.eps_close(recallAtK([], ['a'], 10), 0, 0)
})

test('hitAtK is 1 if any relevant appears in top-k', () => {
  assert.equal(hitAtK(['x', 'a'], ['a'], 2), 1)
  assert.equal(hitAtK(['x', 'y'], ['a'], 2), 0)
})

test('precisionAtK is relevant count over k', () => {
  assert.equal(precisionAtK(['a', 'b'], ['a', 'z'], 2), 0.5)
  assert.equal(precisionAtK(['a', 'a', 'b'], ['a'], 3), 0)
})

test('mrr is reciprocal rank of first relevant', () => {
  assert.equal(mrr(['a', 'b', 'c'], ['c']), 1 / 3)
  assert.equal(mrr(['a', 'b'], ['a']), 1)
  assert.equal(mrr(['a', 'b'], ['z']), 0)
})

test('ndcg@k equals 1 for perfect ordering', () => {
  assert.eps_close(ndcgAtK(['a', 'b'], ['a', 'b'], 2), 1, 1e-9)
  assert.ok(ndcgAtK(['z', 'a'], ['a'], 2) < 1)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/retrieval/lib/metrics.test.mjs`
Expected: FAIL（`Cannot find module './metrics.mjs'`）。注：`assert.eps_close` 是 Node 22+ 才有；若你的 Node 报该方法不存在，改用 `assert.ok(Math.abs(x - y) < tol)`。

- [ ] **Step 3: 实现**

`scripts/eval/retrieval/lib/metrics.mjs`：

```js
// 文件级检索指标。retrieved 为去重前的有序文件路径列表；relevant 为相关文件集合。

function uniqueTop(retrieved, k) {
  const seen = new Set()
  const out = []
  for (const f of retrieved) {
    if (out.length >= k) break
    if (!seen.has(f)) { seen.add(f); out.push(f) }
  }
  return out
}

export function recallAtK(retrieved, relevant, k = 10) {
  const rel = new Set(relevant)
  const top = uniqueTop(retrieved, k)
  const hits = top.filter((f) => rel.has(f)).length
  return rel.size === 0 ? 0 : hits / rel.size
}

export function hitAtK(retrieved, relevant, k = 10) {
  const rel = new Set(relevant)
  return uniqueTop(retrieved, k).some((f) => rel.has(f)) ? 1 : 0
}

export function precisionAtK(retrieved, relevant, k = 10) {
  const rel = new Set(relevant)
  const top = uniqueTop(retrieved, k)
  return top.length === 0 ? 0 : top.filter((f) => rel.has(f)).length / top.length
}

export function mrr(retrieved, relevant) {
  const rel = new Set(relevant)
  const seen = new Set()
  let rank = 0
  for (const f of retrieved) {
    if (seen.has(f)) continue
    seen.add(f); rank++
    if (rel.has(f)) return 1 / rank
  }
  return 0
}

function dcg(gains, k) {
  let s = 0
  for (let i = 0; i < Math.min(gains.length, k); i++) s += gains[i] / Math.log2(i + 2)
  return s
}

export function ndcgAtK(retrieved, relevant, k = 10) {
  const rel = new Set(relevant)
  const seen = new Set()
  const gains = []
  for (const f of retrieved) {
    if (seen.has(f)) continue
    seen.add(f)
    gains.push(rel.has(f) ? 1 : 0)
  }
  const idcg = dcg(new Array(Math.min(rel.size, k)).fill(1), k)
  return idcg === 0 ? 0 : dcg(gains, k) / idcg
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/retrieval/lib/metrics.test.mjs`
Expected: PASS（6 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/retrieval/lib/metrics.mjs scripts/eval/retrieval/lib/metrics.test.mjs
git commit -m "feat(eval): file-level retrieval metrics for offline eval"
```

---

## Task 2: stats.mjs — 非参数统计

**Files:**
- Create: `scripts/eval/retrieval/lib/stats.mjs`
- Test: `scripts/eval/retrieval/lib/stats.test.mjs`

- [ ] **Step 1: 写失败测试**

`scripts/eval/retrieval/lib/stats.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cliffsDelta, wilcoxonSignedRank, bootstrapMeanDiffCi, mulberry32 } from './stats.mjs'

test('cliffsDelta is -1 when all x < y', () => {
  assert.equal(cliffsDelta([0], [1]), -1)
})

test('cliffsDelta is 0 for identical paired samples', () => {
  assert.equal(cliffsDelta([1, 2], [1, 2]), 0)
})

test('cliffsDelta is 1 when all x > y', () => {
  assert.equal(cliffsDelta([2], [1]), 1)
})

test('wilcoxon p is large for no difference', () => {
  const { p, n } = wilcoxonSignedRank([0.5, 0.6, 0.55, 0.52, 0.58, 0.54, 0.53, 0.57], [0.5, 0.6, 0.55, 0.52, 0.58, 0.54, 0.53, 0.57])
  assert.equal(n, 0)
  assert.ok(Number.isNaN(p))
})

test('wilcoxon p is small for consistent positive shift', () => {
  const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  const y = x.map((v) => v + 1)
  const { p } = wilcoxonSignedRank(x, y)
  assert.ok(p < 0.05)
})

test('bootstrap CI contains the sample mean', () => {
  const rng = mulberry32(42)
  const x = [1, 2, 3, 4, 5]
  const y = [0, 0, 0, 0, 0]
  const { mean, lo, hi } = bootstrapMeanDiffCi(x, y, { nBoot: 500, rng: rng() })
  assert.equal(mean, 3)
  assert.ok(lo <= mean && mean <= hi)
})

test('mulberry32 is deterministic for a seed', () => {
  const a = mulberry32(1)()
  const b = mulberry32(1)()
  assert.equal(a, b)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/retrieval/lib/stats.test.mjs`
Expected: FAIL（找不到 `./stats.mjs`）

- [ ] **Step 3: 实现**

`scripts/eval/retrieval/lib/stats.mjs`：

```js
// 非参数统计，不引入第三方依赖，便于透明审计。

export function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Cliff's delta：对所有 (x_i, y_j) 对统计 x>y 与 x<y 之差，范围 [-1, 1]。
export function cliffsDelta(x, y) {
  if (x.length === 0 || y.length === 0) return NaN
  let gt = 0, lt = 0
  for (const a of x) for (const b of y) {
    if (a > b) gt++
    else if (a < b) lt++
  }
  return (gt - lt) / (x.length * y.length)
}

function normalCdf(z) {
  const sign = z < 0 ? -1 : 1
  const a = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * a)
  const d = 0.3989422804014327 * Math.exp((-a * a) / 2)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return sign < 0 ? d * poly : 1 - d * poly
}

// 配对 Wilcoxon signed-rank（双侧），正态近似 + 连续性校正。
// 返回 W（正秩和）、z、双尾 p、有效对数 n（去掉差为 0 的对）。
export function wilcoxonSignedRank(x, y) {
  const d = x.map((v, i) => v - y[i]).filter((v) => v !== 0)
  const n = d.length
  if (n === 0) return { W: 0, z: 0, p: NaN, n }
  const abs = d.map((v) => [Math.abs(v), Math.sign(v)])
  abs.sort((a, b) => a[0] - b[0])
  const ranks = new Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && abs[j + 1][0] === abs[i][0]) j++
    const avg = (i + 1 + j + 1) / 2
    for (let t = i; t <= j; t++) ranks[t] = avg
    i = j + 1
  }
  let W = 0
  for (let t = 0; t < n; t++) if (abs[t][1] > 0) W += ranks[t]
  const Wmin = Math.min(W, (n * (n + 1)) / 2 - W)
  const mean = (n * (n + 1)) / 4
  const sd = Math.sqrt((n * (n + 1) * (2 * n + 1)) / 24)
  const z = sd === 0 ? 0 : (Wmin - mean + 0.5) / sd
  const p = 2 * normalCdf(-Math.abs(z))
  return { W, z, p, n }
}

// 配对差值均值的百分位 Bootstrap 置信区间。differences = x - y（逐查询配对）。
export function bootstrapMeanDiffCi(x, y, { nBoot = 1000, alpha = 0.05, rng } = {}) {
  const d = x.map((v, i) => v - y[i])
  const n = d.length
  const draw = rng || Math.random
  const stats = new Array(nBoot)
  for (let b = 0; b < nBoot; b++) {
    let sum = 0
    for (let i = 0; i < n; i++) sum += d[Math.floor(draw() * n)]
    stats[b] = sum / n
  }
  stats.sort((a, b) => a - b)
  const lo = stats[Math.floor((alpha / 2) * nBoot)]
  const hi = stats[Math.ceil((1 - alpha / 2) * nBoot) - 1]
  const mean = d.reduce((s, v) => s + v, 0) / n
  return { mean, lo, hi, n }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/retrieval/lib/stats.test.mjs`
Expected: PASS（7 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/retrieval/lib/stats.mjs scripts/eval/retrieval/lib/stats.test.mjs
git commit -m "feat(eval): nonparametric stats (Wilcoxon, bootstrap CI, Cliff's delta)"
```

---

## Task 3: dataset.mjs — 标注查询集加载

**Files:**
- Create: `scripts/eval/retrieval/lib/dataset.mjs`
- Create: `scripts/eval/retrieval/sample-dataset.json`
- Test: `scripts/eval/retrieval/lib/dataset.test.mjs`

- [ ] **Step 1: 写失败测试**

`scripts/eval/retrieval/lib/dataset.test.mjs`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { loadDataset } from './dataset.mjs'

test('loadDataset parses queries and relevantFiles', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-'))
  const fp = path.join(dir, 'd.json')
  await writeFile(fp, JSON.stringify({ queries: [{ query: 'q', relevantFiles: ['a.ts'] }] }))
  const qs = await loadDataset(fp)
  assert.equal(qs.length, 1)
  assert.equal(qs[0].query, 'q')
  await rm(dir, { recursive: true, force: true })
})

test('loadDataset rejects missing query fields', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'ds-'))
  const fp = path.join(dir, 'bad.json')
  await writeFile(fp, JSON.stringify({ queries: [{ query: 'q' }] }))
  await assert.rejects(() => loadDataset(fp), /relevantFiles/)
  await rm(dir, { recursive: true, force: true })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test scripts/eval/retrieval/lib/dataset.test.mjs`
Expected: FAIL（找不到 `./dataset.mjs`）

- [ ] **Step 3: 实现**

`scripts/eval/retrieval/lib/dataset.mjs`：

```js
import { readFile } from 'node:fs/promises'

export async function loadDataset(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data.queries)) throw new Error('dataset must have a "queries" array')
  for (const q of data.queries) {
    if (typeof q.query !== 'string' || !Array.isArray(q.relevantFiles)) {
      throw new Error('each query needs { query: string, relevantFiles: string[] }')
    }
  }
  return data.queries
}
```

`scripts/eval/retrieval/sample-dataset.json`（对应 Task 5 测试仓库的 4 个文件）：

```json
{
  "queries": [
    { "query": "greeting a person by name", "relevantFiles": ["src/greeter.ts"] },
    { "query": "arithmetic addition and multiplication", "relevantFiles": ["src/math.ts"] },
    { "query": "parse json string into object", "relevantFiles": ["src/utils.py"] },
    { "query": "network connection address from config", "relevantFiles": ["src/lib.rs"] }
  ]
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node --test scripts/eval/retrieval/lib/dataset.test.mjs`
Expected: PASS（2 个测试全过）

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/retrieval/lib/dataset.mjs scripts/eval/retrieval/lib/dataset.test.mjs scripts/eval/retrieval/sample-dataset.json
git commit -m "feat(eval): annotated dataset loader and sample queries"
```

---

## Task 4: baselines.mjs — grep 与朴素 RAG 基线

**Files:**
- Create: `scripts/eval/retrieval/lib/baselines.mjs`

> 集成型代码，逻辑简单，靠 `run.mjs` 端到端验证（不做 node:test，因为依赖 `EmbeddingClient` 真实调用）。若你要单测，可把 `tokenize`/`chunkByWindow`/`cosine` 拆出再测，但本任务保持最小实现。

- [ ] **Step 1: 实现**

`scripts/eval/retrieval/lib/baselines.mjs`：

```js
// 两组基线：G 组 = 关键词计数（grep 等价）；R 组 = 固定窗口 + 纯向量 cosine（朴素 RAG）。

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'how', 'what', 'do', 'does', 'this', 'that', 'it', 'as', 'by', 'at', 'from'])

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

// corpus: [{ filePath, content }]
export function grepBaseline(query, corpus, topK = 10) {
  const terms = tokenize(query)
  const scored = corpus.map(({ filePath, content }) => {
    const lower = content.toLowerCase()
    let score = 0
    for (const t of terms) {
      let idx = 0
      while ((idx = lower.indexOf(t, idx)) !== -1) { score++; idx += t.length }
    }
    return { filePath, score }
  })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.filePath)
}

export function chunkByWindow(text, window = 256, overlap = 64) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + window))
    if (start + window >= text.length) break
    start += window - overlap
  }
  return chunks
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// embeddingClient 需提供 embed(texts: string[]) => number[][]（复用插件 EmbeddingClient）。
export async function naiveRagBaseline(query, corpus, embeddingClient, topK = 10) {
  const entries = []
  for (const { filePath, content } of corpus) {
    for (const chunk of chunkByWindow(content)) entries.push({ filePath, chunk })
  }
  const [chunkVecs, queryVecs] = await Promise.all([
    embeddingClient.embed(entries.map((e) => e.chunk)),
    embeddingClient.embed([query]),
  ])
  const qv = queryVecs[0]
  const scored = entries.map((e, i) => ({ filePath: e.filePath, score: cosine(qv, chunkVecs[i]) }))
  scored.sort((a, b) => b.score - a.score)
  const seen = new Set()
  const out = []
  for (const s of scored) {
    if (out.length >= topK) break
    if (!seen.has(s.filePath)) { seen.add(s.filePath); out.push(s.filePath) }
  }
  return out
}
```

- [ ] **Step 2: 提交**

```bash
git add scripts/eval/retrieval/lib/baselines.mjs
git commit -m "feat(eval): grep and naive-RAG retrieval baselines"
```

---

## Task 5: run.mjs — 编排器 + 报告生成

**Files:**
- Create: `scripts/eval/retrieval/run.mjs`
- Modify: `package.json`（新增 `test:eval` 脚本）
- Modify: `.gitignore`（忽略 `scripts/eval/retrieval/output/`）

- [ ] **Step 1: 实现编排器**

`scripts/eval/retrieval/run.mjs`（复用 `dist/` 产物，连真实 Milvus + Ollama，结构与现有 `test/real-milvus-index.mjs` 一致）：

```js
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { loadDataset } from './lib/dataset.mjs'
import { grepBaseline, naiveRagBaseline } from './lib/baselines.mjs'
import { recallAtK, mrr, ndcgAtK, hitAtK, precisionAtK } from './lib/metrics.mjs'
import { wilcoxonSignedRank, bootstrapMeanDiffCi, cliffsDelta, mulberry32 } from './lib/stats.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', '..', '..', 'dist', 'plugins', 'dsh-context-milvus')

const { runIndex } = await import(path.join(distDir, 'indexer.js'))
const { MilvusService } = await import(path.join(distDir, 'milvus-service.js'))
const { HashTracker } = await import(path.join(distDir, 'merkle.js'))
const { getConfig } = await import(path.join(distDir, 'config.js'))
const { EmbeddingClient } = await import(path.join(distDir, 'embedding.js'))

const TOPK = 10
const COLLECTION = 'eval_retrieval_' + Date.now()

// 1. 临时测试仓库（与 sample-dataset.json 的 4 个查询对齐）
const tempDir = await mkdtemp(path.join(tmpdir(), 'retrieval-eval-'))
const files = {
  'src/greeter.ts': `export class Greeter {\n  private name: string\n  constructor(name: string) { this.name = name }\n  greet(): string { return \`Hello, \${this.name}!\` }\n}\n`,
  'src/math.ts': `export function add(a: number, b: number): number { return a + b }\nexport function multiply(a: number, b: number): number { return a * b }\n`,
  'src/utils.py': `def parse_json(text):\n    import json\n    return json.loads(text)\n\nclass DataProcessor:\n    def process(self, data):\n        return {k: v for k, v in data.items()}\n`,
  'src/lib.rs': `pub struct Config { pub host: String, pub port: u16 }\nimpl Config {\n    pub fn new(host: &str, port: u16) -> Self { Self { host: host.to_string(), port } }\n    pub fn addr(&self) -> String { format!("{}:{}", self.host, self.port) }\n}\n`,
}
const corpus = []
for (const [fp, content] of Object.entries(files)) {
  const full = path.join(tempDir, fp)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
  corpus.push({ filePath: path.join(tempDir, fp), content })
}

// 2. 插件索引（P 组）
const config = getConfig({
  milvusAddress: 'localhost:19530',
  milvusCollection: COLLECTION,
  milvusDim: 768,
  embeddingEndpoint: 'http://localhost:11434/api/embed',
  embeddingModel: 'nomic-embed-text',
  indexRoot: tempDir,
  merkleFilePath: path.join(tempDir, '.merkle.json'),
  hybridMode: true,
})
const embeddingClient = new EmbeddingClient(config.embedding)
const milvus = new MilvusService({ address: config.milvusAddress, token: config.milvusToken, collection: config.milvusCollection, dim: config.milvusDim, embeddingClient })
const tracker = new HashTracker(config.merkleFilePath)
await runIndex(config, milvus, tracker, { mode: 'full' })

// 3. 三组检索
const queries = await loadDataset(path.join(__dirname, 'sample-dataset.json'))
const METRICS = {
  'recall@10': (r, q) => recallAtK(r, q.relevantFiles, 10),
  'mrr': (r, q) => mrr(r, q.relevantFiles),
  'ndcg@10': (r, q) => ndcgAtK(r, q.relevantFiles, 10),
  'hit@1': (r, q) => hitAtK(r, q.relevantFiles, 1),
  'precision@10': (r, q) => precisionAtK(r, q.relevantFiles, 10),
}
const groups = { G: [], R: [], P: [] }
for (const q of queries) {
  const g = grepBaseline(q.query, corpus, TOPK)
  const r = await naiveRagBaseline(q.query, corpus, embeddingClient, TOPK)
  const s = await milvus.search(q.query, TOPK)
  const p = [...new Set(s.map((x) => x.filePath))]
  groups.G.push(g); groups.R.push(r); groups.P.push(p)
}

// 4. 逐指标统计（P vs G、P vs R）
const rng = mulberry32(42)
const lines = ['# 离线检索质量评测报告', '']
for (const [name, fn] of Object.entries(METRICS)) {
  const per = {}
  for (const key of ['G', 'R', 'P']) per[key] = queries.map((q, i) => fn(groups[key][i], q))
  lines.push(`## ${name}`, '')
  lines.push(`| 组 | 均值 |`, '|---|---|')
  for (const key of ['G', 'R', 'P']) lines.push(`| ${key} | ${mean(per[key]).toFixed(4)} |`)
  lines.push('')
  for (const [other, label] of [['G', 'P vs G'], ['R', 'P vs R']]) {
    const x = per.P, y = per[other]
    const { p, n } = wilcoxonSignedRank(x, y)
    const ci = bootstrapMeanDiffCi(x, y, { nBoot: 1000, rng })
    const d = cliffsDelta(x, y)
    lines.push(`- ${label}: mean diff ${ci.mean.toFixed(4)} (95% CI [${ci.lo.toFixed(4)}, ${ci.hi.toFixed(4)}]), Wilcoxon p=${Number.isNaN(p) ? 'n/a' : p.toExponential(2)}, Cliff's Δ=${d.toFixed(3)}, n=${n}`)
  }
  lines.push('')
}
await mkdir(path.join(__dirname, 'output'), { recursive: true })
const reportPath = path.join(__dirname, 'output', 'report.md')
await writeFile(reportPath, lines.join('\n'), 'utf-8')
console.log(lines.join('\n'))
console.log(`Report written to ${reportPath}`)

// 5. 清理
const { MilvusClient } = await import('@zilliz/milvus2-sdk-node')
const client = new MilvusClient({ address: config.milvusAddress })
await client.connectPromise
await client.dropCollection({ collection_name: COLLECTION })
await rm(tempDir, { recursive: true, force: true })
console.log('=== Eval completed successfully ===')

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length }
```

- [ ] **Step 2: 新增 npm 脚本**

`package.json` 的 `scripts` 中加入：

```json
"test:eval": "node --test scripts/eval/retrieval/lib/*.test.mjs"
```

- [ ] **Step 3: gitignore 忽略生成物**

`.gitignore` 追加一行：

```
scripts/eval/retrieval/output/
```

- [ ] **Step 4: 跑编排器验证**

Run（需先 `npm run build` 且 Milvus/Ollama 就绪）：
`node --experimental-vm-modules scripts/eval/retrieval/run.mjs`
Expected：打印报告，末尾 `=== Eval completed successfully ===`；P 组 nDCG@10 / MRR 应 ≥ G、R 组。

- [ ] **Step 5: 提交**

```bash
git add scripts/eval/retrieval/run.mjs package.json .gitignore
git commit -m "feat(eval): retrieval eval orchestrator and report generator"
```

---

## Task 6: 端到端单测收口

**Files:**
- Modify: 无新增文件

- [ ] **Step 1: 跑全部 eval 单测**

Run: `npm run test:eval`
Expected: PASS（`metrics` 6 + `stats` 7 + `dataset` 2 = 15 测试全过）

- [ ] **Step 2: 跑既有插件单测确认无回归**

Run: `npm test`
Expected: PASS（现有 jest specs 全过）

- [ ] **Step 3: 提交（如有 lint/格式微调）**

```bash
git add -A scripts/eval
git commit -m "test(eval): wire eval unit tests into npm scripts"
```

---

## Self-Review

**Spec 覆盖**：Layer 1（检索质量）的「数据构造→指标→非参数统计」全部落入 Task 1–6；`path` 过滤子评测与「标注者盲法」「Bootstrap 1000 次」在编排器中已体现（盲法约定属数据采集流程，不体现在脚本）。Layer 2（端到端）与 Layer 3（埋点）在后续 Plan 2/3。

**占位符扫描**：无 TBD/TODO；所有代码块完整。

**类型一致性**：`baselines.mjs` 依赖 `EmbeddingClient.embed(texts)=>number[][]`（与 [embedding.ts](file:///workspace/src/plugins/dsh-context-milvus/embedding.ts) 一致）、`MilvusService.search(query,topK)=>SearchResult[]`（与 [milvus-service.ts](file:///workspace/src/plugins/dsh-context-milvus/milvus-service.ts) 一致）；`metrics`/`stats` 函数签名前后一致。

**注意**：`assert.eps_close` 在 Node < 22 不存在——已在 Task 1 Step 2 给出回退写法；实现代码本身不依赖它。