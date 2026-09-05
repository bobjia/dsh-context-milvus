// 三组重复测量的非参数统计：Friedman 主效应 + Nemenyi 事后 + McNemar + Holm 校正。
// chi2 生存函数用不完全伽马函数（NR gammp/gammq 系列 + 连分式）。

function normalCdf(z) {
  const sign = z < 0 ? -1 : 1
  const a = Math.abs(z)
  const t = 1 / (1 + 0.2316419 * a)
  const d = 0.3989422804014327 * Math.exp((-a * a) / 2)
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))))
  return sign < 0 ? d * poly : 1 - d * poly
}

function logGamma(x) {
  const cof = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = x
  let tmp = x + 5.5
  tmp -= (x + 0.5) * Math.log(tmp)
  let ser = 1.000000000190015
  for (let j = 0; j < 6; j++) ser += cof[j] / ++y
  return -tmp + Math.log(2.5066282746310005 * ser / x)
}

function gser(a, x) {
  const ITMAX = 100, EPS = 3e-7
  let sum = 1 / a
  let ap = a
  let del = sum
  for (let n = 0; n < ITMAX; n++) {
    ap += 1
    del *= x / ap
    sum += del
    if (Math.abs(del) < Math.abs(sum) * EPS) break
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a))
}

function gcf(a, x) {
  const ITMAX = 100, EPS = 3e-7, FPMIN = 1e-30
  let b = x + 1 - a
  let c = 1 / FPMIN
  let d = 1 / b
  let h = d
  for (let i = 1; i <= ITMAX; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = b + an / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return Math.exp(-x + a * Math.log(x) - logGamma(a)) * h
}

function gammp(a, x) { return x < a + 1 ? gser(a, x) : 1 - gcf(a, x) }

// 卡方分布生存函数 P(X > x)，df 为自由度。
export function chi2Survival(x, df) {
  if (df === 1) return 2 * (1 - normalCdf(Math.sqrt(x)))
  if (df === 2) return Math.exp(-x / 2)
  return 1 - gammp(df / 2, x / 2)
}

// 配对秩平均（块内并列取平均秩）
function rankWithin(row) {
  const g = row.length
  const sorted = row.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const r = new Array(g)
  let i = 0
  while (i < g) {
    let j = i
    while (j + 1 < g && sorted[j + 1].v === sorted[i].v) j++
    const avg = (i + 1 + j + 1) / 2
    for (let t = i; t <= j; t++) r[sorted[t].i] = avg
    i = j + 1
  }
  return r
}

// Friedman 检验（含并列校正）。matrix: n 行（任务）× g 列（组）。
export function friedman(matrix) {
  const n = matrix.length
  if (n === 0) throw new Error('friedman: empty matrix')
  const g = matrix[0].length
  if (g < 2) throw new Error('friedman: need >= 2 groups')
  const R = new Array(g).fill(0)
  for (const row of matrix) {
    const r = rankWithin(row)
    for (let j = 0; j < g; j++) R[j] += r[j]
  }
  let tieSum = 0
  for (const raw of matrix) {
    const sorted = [...raw].sort((a, b) => a - b)
    let i = 0
    while (i < g) {
      let j = i
      while (j + 1 < g && sorted[j + 1] === sorted[i]) j++
      const t = j - i + 1
      if (t > 1) tieSum += t * t * t - t
      i = j + 1
    }
  }
  const Q = (12 / (n * g * (g + 1))) * R.reduce((s, r) => s + (r - (n * (g + 1)) / 2) ** 2, 0)
  const C1 = 1 - tieSum / (n * g * (g * g - 1))
  const Qcorr = C1 > 0 ? Q / C1 : Q
  const df = g - 1
  return { Q: Qcorr, df, p: chi2Survival(Qcorr, df), rankSums: R, n, g }
}

// Nemenyi 事后检验的临界差 CD（学生化极差表，α=0.05，df=∞）。
const STUDENTIZED_RANGE = { 2: 1.960, 3: 3.314, 4: 3.633, 5: 3.858, 6: 4.030, 7: 4.170, 8: 4.286, 9: 4.387, 10: 4.474 }

export function nemenyiCD(n, g, alpha = 0.05) {
  if (alpha !== 0.05) throw new Error('nemenyiCD: only alpha=0.05 table provided')
  const q = STUDENTIZED_RANGE[g] ?? 3.858
  return q * Math.sqrt((g * (g + 1)) / (12 * n))
}

// McNemar（配对比例，连续性校正）。b = P 成而 X 败，c = X 成而 P 败。
export function mcnemar(b, c) {
  const n = b + c
  if (n === 0) return { chi2: 0, p: NaN, n }
  const chi2 = (Math.abs(b - c) - 1) ** 2 / n
  return { chi2, p: chi2Survival(chi2, 1), n }
}

// Holm 序贯 Bonferroni 校正。返回与输入同序的拒绝布尔数组。
export function holm(pValues, alpha = 0.05) {
  const m = pValues.length
  const idx = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const reject = new Array(m).fill(false)
  for (let k = 0; k < m; k++) {
    if (idx[k].p <= alpha / (m - k)) reject[idx[k].i] = true
    else break
  }
  return reject
}
