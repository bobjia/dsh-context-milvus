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
