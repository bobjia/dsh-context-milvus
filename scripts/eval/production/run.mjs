/**
 * 生产检索质量评测管道（线上日志 → 离线标注 → 指标报告）
 *
 * 线上没有 ground truth，标准做法是"线上日志 + 离线标注"：
 *   1. sample  从 telemetry.jsonl 抽样真实查询，重跑检索，生成待标注文件
 *   2. label   对每个查询用 LLM 建议相关文件（半自动标注）
 *   3. eval    读标注文件，重跑检索，复用 retrieval/metrics.mjs 计算
 *              hit@1 / MRR / recall@10 / precision@10（文件级 + 条目级）
 *
 * 用法：
 *   node scripts/eval/production/run.mjs sample --telemetry ~/.milvus-index/telemetry.jsonl \
 *       --index-root /path/to/repo --count 30 --out queries.to-label.json
 *   node scripts/eval/production/run.mjs label --unlabeled queries.to-label.json \
 *       --index-root /path/to/repo --model-endpoint http://localhost:11434/v1/chat/completions \
 *       --model llama3.1 --out queries.labeled.json
 *   node scripts/eval/production/run.mjs eval --labeled queries.labeled.json \
 *       --out report.md
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { loadDataset } from '../retrieval/lib/dataset.mjs'
import { recallAtK, mrr, ndcgAtK, hitAtK, precisionAtK, precisionAtKChunk } from '../retrieval/lib/metrics.mjs'
import { wilcoxonSignedRank, bootstrapMeanDiffCi, cliffsDelta, mulberry32 } from '../retrieval/lib/stats.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', '..', '..', 'dist', 'plugins', 'dsh-context-milvus')

const { MilvusService } = await import(path.join(distDir, 'milvus-service.js'))
const { getConfig } = await import(path.join(distDir, 'config.js'))
const { EmbeddingClient } = await import(path.join(distDir, 'embedding.js'))

const TOPK = 10

const args = process.argv.slice(2)
const cmd = args[0]
const getArg = (name, def) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : def
}

/** 从 telemetry.jsonl 抽取 search_code 条目 */
async function loadSearchEntries(telemetryFile) {
  const text = await readFile(telemetryFile, 'utf-8').catch(() => '')
  const entries = text.split('\n').filter(Boolean).map((l) => {
    try { return JSON.parse(l) } catch { return null }
  }).filter((e) => e && e.tool === 'search_code' && e.query && e.resultCount > 0)
  return entries
}

/** 按时间分层抽样（确定性 seed） */
function stratifiedSample(entries, count, seed = 42) {
  const rng = mulberry32(seed)
  const sorted = [...entries].sort((a, b) => (a.ts < b.ts ? -1 : 1))
  // 等分 time buckets，每桶抽 1 个，保证时间覆盖
  const buckets = Math.min(count, sorted.length)
  const out = []
  for (let i = 0; i < buckets; i++) {
    const start = Math.floor((i / buckets) * sorted.length)
    const end = Math.floor(((i + 1) / buckets) * sorted.length)
    const bucket = sorted.slice(start, end)
    if (bucket.length === 0) continue
    out.push(bucket[Math.floor(rng() * bucket.length)])
  }
  return out
}

async function createMilvus(indexRoot) {
  const config = getConfig({
    milvusAddress: process.env.MILVUS_ADDRESS ?? 'localhost:19530',
    milvusToken: process.env.MILVUS_TOKEN,
    milvusCollection: process.env.MILVUS_COLLECTION,
    milvusDim: Number(process.env.MILVUS_DIM ?? 768),
    embeddingEndpoint: process.env.EMBEDDING_ENDPOINT ?? 'http://localhost:11434/api/embed',
    embeddingModel: process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
    indexRoot,
    hybridMode: process.env.HYBRID_MODE !== 'false',
  })
  const embeddingClient = new EmbeddingClient(config.embedding)
  const milvus = new MilvusService({
    address: config.milvusAddress,
    token: config.milvusToken,
    collection: config.milvusCollection,
    dim: config.milvusDim,
    embeddingClient,
    hybridMode: config.hybridMode,
    bm25RrfK: config.bm25RrfK,
  })
  await milvus.ensureCollection()
  return milvus
}

async function cmdSample() {
  const telemetryFile = getArg('--telemetry', path.join(process.env.HOME ?? '', '.milvus-index', 'telemetry.jsonl'))
  const indexRoot = getArg('--index-root')
  const count = Number(getArg('--count', '30'))
  const out = getArg('--out', 'queries.to-label.json')
  if (!indexRoot) throw new Error('--index-root required')
  if (!existsSync(telemetryFile)) throw new Error(`telemetry file not found: ${telemetryFile}`)

  const entries = await loadSearchEntries(telemetryFile)
  if (entries.length === 0) throw new Error('no search_code entries with results found in telemetry')
  const sampled = stratifiedSample(entries, count)
  console.log(`Sampled ${sampled.length} queries from ${entries.length} search_code entries`)

  const milvus = await createMilvus(indexRoot)
  const queries = []
  for (const e of sampled) {
    const topK = Number(e.topK ?? TOPK)
    const results = await milvus.search(e.query, topK, e.path || undefined)
    queries.push({
      query: e.query,
      topK,
      path: e.path ?? '',
      ts: e.ts,
      results: results.map((r) => ({ filePath: r.filePath, score: r.score, name: r.name, chunkType: r.chunkType })),
      relevantFiles: [],
    })
  }
  await writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), queries }, null, 2), 'utf-8')
  console.log(`Wrote ${out} (${queries.length} queries, relevantFiles empty — fill in via label step)`)
}

async function cmdLabel() {
  const unlabeled = getArg('--unlabeled')
  const indexRoot = getArg('--index-root')
  const endpoint = getArg('--model-endpoint', 'http://localhost:11434/v1/chat/completions')
  const model = getArg('--model', 'llama3.1')
  const out = getArg('--out', 'queries.labeled.json')
  if (!unlabeled || !indexRoot) throw new Error('--unlabeled and --index-root required')

  const data = JSON.parse(await readFile(unlabeled, 'utf-8'))
  const { fileList } = await buildFileList(indexRoot)
  console.log(`Codebase file count: ${fileList.length}`)

  for (const q of data.queries) {
    const suggestion = await llmSuggestRelevant(endpoint, model, q, fileList)
    q.relevantFiles = suggestion
    console.log(`  "${q.query.slice(0, 50)}" → ${suggestion.length} files`)
  }
  await writeFile(out, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`Wrote labeled data to ${out}`)
}

/** 构建代码库文件清单（供标注用） */
async function buildFileList(indexRoot) {
  const { readdir } = await import('node:fs/promises')
  const files = []
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'build') continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else files.push(full)
    }
  }
  await walk(indexRoot)
  return { fileList: files }
}

/** 调用 LLM 建议相关文件（返回绝对路径数组） */
async function llmSuggestRelevant(endpoint, model, q, fileList) {
  const root = path.dirname(fileList[0] ?? '')
  const prompt = `你是代码检索评测标注助手。给定一个自然语言查询和代码库文件清单，判断哪些文件与该查询相关（可能包含该功能的实现、被其调用、或其依赖）。

查询: ${q.query}

代码库文件清单（前 200 个）:
${fileList.slice(0, 200).map((f) => path.relative(root, f)).join('\n')}

请只输出与查询相关的文件路径，每行一个，不要输出其他内容。如果没有相关文件，输出 <none>。`
  const resp = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 512,
    }),
  })
  if (!resp.ok) throw new Error(`LLM label failed: ${resp.status} ${await resp.text()}`)
  const json = await resp.json()
  const text = json?.choices?.[0]?.message?.content ?? ''
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  return lines.filter((l) => !l.startsWith('<none>'))
}

async function cmdEval() {
  const labeled = getArg('--labeled')
  const out = getArg('--out', 'report.md')
  if (!labeled) throw new Error('--labeled required')

  const data = JSON.parse(await readFile(labeled, 'utf-8'))
  const queries = data.queries
  if (!queries.length) throw new Error('no queries in labeled data')
  const indexRoot = getArg('--index-root', path.dirname(queries[0].results?.[0]?.filePath ?? ''))
  const milvus = await createMilvus(indexRoot)

  // 重跑检索，得到当前索引下的结果（与 sample 步骤一致，保证可复现性）
  const groups = { P: [], PRaw: [] }
  for (const q of queries) {
    const topK = Number(q.topK ?? TOPK)
    const s = await milvus.search(q.query, topK, q.path || undefined)
    const relevant = q.relevantFiles.map((f) => path.resolve(f))
    groups.P.push([...new Set(s.map((x) => x.filePath))])
    groups.PRaw.push(s.map((x) => x.filePath))
    q.relevantFiles = relevant
  }

  const rng = mulberry32(42)
  const lines = ['# 生产检索质量评测报告', '']
  lines.push(`- 数据来源: ${labeled}`)
  lines.push(`- 查询数: ${queries.length}`)
  lines.push('')
  const METRICS = {
    'recall@10': (r, q) => recallAtK(r, q.relevantFiles, 10),
    'mrr': (r, q) => mrr(r, q.relevantFiles),
    'ndcg@10': (r, q) => ndcgAtK(r, q.relevantFiles, 10),
    'hit@1': (r, q) => hitAtK(r, q.relevantFiles, 1),
    'precision@10 (file)': (r, q) => precisionAtK(r, q.relevantFiles, 10),
    'precision@10 (chunk)': (r, q) => precisionAtKChunk(r, q.relevantFiles, 10),
  }
  for (const [name, fn] of Object.entries(METRICS)) {
    const perP = queries.map((q, i) => fn(groups.P[i], q))
    const perRaw = queries.map((q, i) => fn(groups.PRaw[i], q))
    lines.push(`## ${name}`, '')
    lines.push(`| 组 | 均值 |`, '|---|---|')
    lines.push(`| P (file-dedup) | ${mean(perP).toFixed(4)} |`)
    lines.push(`| P (chunk) | ${mean(perRaw).toFixed(4)} |`)
    lines.push('')
  }

  await mkdir(path.dirname(path.resolve(out)), { recursive: true })
  await writeFile(out, lines.join('\n'), 'utf-8')
  console.log(lines.join('\n'))
  console.log(`Report written to ${out}`)
}

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length }

if (cmd === 'sample') await cmdSample()
else if (cmd === 'label') await cmdLabel()
else if (cmd === 'eval') await cmdEval()
else {
  console.log(`用法: node ${path.basename(import.meta.url)} <sample|label|eval> [options]`)
  console.log('  sample: --telemetry <jsonl> --index-root <dir> --count <N> --out <file>')
  console.log('  label:  --unlabeled <json> --index-root <dir> [--model-endpoint url] [--model name] --out <file>')
  console.log('  eval:   --labeled <json> [--index-root dir] --out <file>')
  process.exit(1)
}
