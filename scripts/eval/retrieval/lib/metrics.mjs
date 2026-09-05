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
