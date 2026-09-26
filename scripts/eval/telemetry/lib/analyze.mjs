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

/**
 * 按量级自适应小数位的数值格式化。
 *
 * 曾统一用 `toFixed(1)`：真实 RRF 融合分量级约 0.03，于是报告里 topScore 的
 * 中位数 / IQR / 均值全被抹成 "0.0"——而它恰恰是唯一能反映命中深浅的字段。
 * 计数与延迟（>=1）维持原有 1 位小数，<1 的值改用 5 位有效数字。
 */
export function formatNumber(v, sig = 5) {
  if (!Number.isFinite(v)) return String(v)
  if (v === 0) return '0'
  return Math.abs(v) >= 1 ? v.toFixed(1) : String(Number(v.toPrecision(sig)))
}

/**
 * 分数语义说明行。默认 hybridMode 下 Milvus 返回的是 RRF 融合分
 * `Σ 1/(k + 名次)`（k = bm25RrfK，默认 60），只编码名次，不是相似度；
 * 旧条目没有 `scoreKind` 字段，无法区分两种语义，单独计数以便警惕。
 */
export function scoreSemantics(entries) {
  const count = { rrf: 0, similarity: 0, unlabeled: 0 }
  let k = null
  for (const e of entries) {
    if (e.scoreKind === 'rrf') count.rrf++
    else if (e.scoreKind === 'similarity') count.similarity++
    else if (Number.isFinite(Number(e.topScore))) count.unlabeled++
    if (Number.isFinite(Number(e.bm25RrfK))) k = Number(e.bm25RrfK)
  }
  const lines = [
    `- 分数语义: rrf=${count.rrf}, similarity=${count.similarity}, 未标注=${count.unlabeled}`,
  ]
  if (count.rrf > 0 || count.unlabeled > 0) {
    const kText = k === null ? 'bm25RrfK，默认 60' : `bm25RrfK=${k}`
    lines.push(
      `- ⚠ RRF 分是 1/(k+名次) 的名次编码（${kText}），不是相似度：` +
        '不要按绝对分值判断检索质量；未标注的行无法区分两种语义',
    )
  }
  return lines
}
