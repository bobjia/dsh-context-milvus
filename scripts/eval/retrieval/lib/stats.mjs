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
