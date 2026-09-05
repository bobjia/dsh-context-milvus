// 两组基线：G 组 = 关键词计数（grep 等价）；R 组 = 固定窗口 + 纯向量 cosine（朴素 RAG）。

const STOPWORDS = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'for', 'with', 'is', 'are', 'how', 'what', 'do', 'does', 'this', 'that', 'it', 'as', 'by', 'at', 'from'])

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length > 1 && !STOPWORDS.has(w))
}

// corpus: [{ filePath, content }]
export function grepBaseline(query, corpus, topK = 10) {
  const terms = tokenize(query)
  const scored = corpus.map(({ filePath, content }) => {
    const lower = content.toLowerCase()
    let score = 0
    for (const t of terms) {
      let idx = 0
      while ((idx = lower.indexOf(t, idx)) !== -1) { score++; idx += t.length }
    }
    return { filePath, score }
  })
  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((x) => x.filePath)
}

export function chunkByWindow(text, window = 256, overlap = 64) {
  const chunks = []
  let start = 0
  while (start < text.length) {
    chunks.push(text.slice(start, start + window))
    if (start + window >= text.length) break
    start += window - overlap
  }
  return chunks
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1)
}

// embeddingClient 需提供 embed(texts: string[]) => number[][]（复用插件 EmbeddingClient）。
export async function naiveRagBaseline(query, corpus, embeddingClient, topK = 10) {
  const entries = []
  for (const { filePath, content } of corpus) {
    for (const chunk of chunkByWindow(content)) entries.push({ filePath, chunk })
  }
  const [chunkVecs, queryVecs] = await Promise.all([
    embeddingClient.embed(entries.map((e) => e.chunk)),
    embeddingClient.embed([query]),
  ])
  const qv = queryVecs[0]
  const scored = entries.map((e, i) => ({ filePath: e.filePath, score: cosine(qv, chunkVecs[i]) }))
  scored.sort((a, b) => b.score - a.score)
  const seen = new Set()
  const out = []
  for (const s of scored) {
    if (out.length >= topK) break
    if (!seen.has(s.filePath)) { seen.add(s.filePath); out.push(s.filePath) }
  }
  return out
}
