// 确定性参考 driver：按 (task, group) 种子决定通过率/指标，不依赖真实 DSH。
// 真实 DSH driver 遵循同一 CLI 契约：--task <id> --group <G|R|P> --root <dir>，stdout 输出一行 JSON。
import { mulberry32 } from '../../retrieval/lib/stats.mjs'

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
