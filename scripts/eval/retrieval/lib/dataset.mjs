import { readFile } from 'node:fs/promises'

export async function loadDataset(filePath) {
  const raw = await readFile(filePath, 'utf8')
  const data = JSON.parse(raw)
  if (!Array.isArray(data.queries)) throw new Error('dataset must have a "queries" array')
  for (const q of data.queries) {
    if (typeof q.query !== 'string' || !Array.isArray(q.relevantFiles)) {
      throw new Error('each query needs { query: string, relevantFiles: string[] }')
    }
  }
  return data.queries
}
