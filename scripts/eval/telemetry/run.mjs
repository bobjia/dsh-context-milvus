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
  search_code: ['resultCount', 'topScore', 'durationMs', 'rerankFlipCount'],
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

// 分类指标：布尔字段比率 + 零结果率
if (searches.length > 0) {
  const rate = (pred) => {
    const n = searches.filter((e) => pred(e)).length
    return { n, rate: n / searches.length }
  }
  const zeroResult = rate((e) => Number(e.resultCount) === 0)
  const expanded = rate((e) => e.queryExpansionApplied === true)
  const reranked = rate((e) => e.rerankEnabled === true)
  const top1Flipped = rate((e) => e.rerankTop1Flipped === true)
  lines.push('')
  lines.push('## 分类指标（search_code）', '')
  lines.push(`- 零结果率: ${zeroResult.n}/${searches.length} = ${(zeroResult.rate * 100).toFixed(1)}%`)
  lines.push(`- 查询扩展应用率: ${expanded.n}/${searches.length} = ${(expanded.rate * 100).toFixed(1)}%`)
  lines.push(`- reranker 启用率: ${reranked.n}/${searches.length} = ${(reranked.rate * 100).toFixed(1)}%`)
  lines.push(`- rerank 翻转 top-1 率: ${top1Flipped.n}/${searches.length} = ${(top1Flipped.rate * 100).toFixed(1)}%`)
  // 平均翻转数（仅 rerank 启用的搜索）
  const flips = searches.filter((e) => e.rerankEnabled === true).map((e) => Number(e.rerankFlipCount)).filter((v) => Number.isFinite(v))
  if (flips.length > 0) {
    lines.push(`- rerank 平均翻转数: ${(flips.reduce((a, b) => a + b, 0) / flips.length).toFixed(2)} (n=${flips.length})`)
  }
}
lines.push('')

await mkdir(path.join(__dirname, 'output'), { recursive: true })
const reportPath = path.join(__dirname, 'output', 'report.md')
await writeFile(reportPath, lines.join('\n'), 'utf-8')
console.log(lines.join('\n'))
console.log(`Report written to ${reportPath}`)
