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
const milvus = new MilvusService({ address: config.milvusAddress, token: config.milvusToken, collection: config.milvusCollection, dim: config.milvusDim, embeddingClient, hybridMode: config.hybridMode, bm25RrfK: config.bm25RrfK })
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
