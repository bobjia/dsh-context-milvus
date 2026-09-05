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
