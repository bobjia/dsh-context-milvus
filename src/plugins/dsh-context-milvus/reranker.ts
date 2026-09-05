/**
 * Lightweight two-stage reranker.
 *
 * Stage 1: Retrieve topK × multiplier results from Milvus hybrid search.
 * Stage 2: Rerank using a composite score that combines:
 *   - Original RRF/vector score (primary signal)
 *   - Proportional query-term overlap boost (max +30%)
 *   - Proportional name match boost (max +15%)
 *
 * All bonuses are PROPORTIONAL to the base score, not absolute, because
 * RRF scores are typically tiny (~0.01-0.05). An absolute bonus would
 * dominate the base signal and reorder purely by keyword overlap.
 *
 * No additional model calls — pure heuristic reranking on top of Milvus scores.
 */

import type { SearchResult } from './types.js'

export interface RerankConfig {
  enabled: boolean
  /** How many times topK to fetch before reranking (e.g., 3 -> fetch 30 for a topK=10 query) */
  multiplier: number
}

/** Maximum fractional boost from full query-term overlap (max +30%) */
const OVERLAP_BOOST = 0.3
/** Maximum fractional boost from name match (max +15%) */
const NAME_BOOST = 0.15

/**
 * Rerank search results by combining the original score with heuristic signals.
 *
 * @param query - The original user query (before expansion)
 * @param results - Stage-1 search results from Milvus
 * @param topK - Number of final results to return
 * @returns Reranked top-K results
 */
export function rerankResults(query: string, results: SearchResult[], topK: number): SearchResult[] {
  if (results.length <= 1) return results

  // Tokenize query for term matching
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1)

  // Score each result with proportional bonuses
  const scored = results.map((r) => {
    const baseScore = r.score ?? 0
    const content = (r.content ?? '').toLowerCase()
    const name = (r.name ?? '').toLowerCase()

    // 1. Query-term overlap ratio
    let termOverlap = 0
    let termCount = 0
    for (const term of queryTerms) {
      if (STOP_WORDS.has(term)) continue
      termCount++
      if (content.includes(term)) termOverlap++
    }
    const overlapRatio = termCount > 0 ? termOverlap / termCount : 0

    // 2. Name match: does the chunk's function/class name appear in the query?
    let nameMatch = 0
    if (name.length > 1) {
      for (const term of queryTerms) {
        if (name.includes(term) || term.includes(name)) {
          nameMatch = 1
          break
        }
      }
    }

    // Proportional composite: base x (1 + overlap boost + name boost)
    const rerankScore = baseScore * (1 + overlapRatio * OVERLAP_BOOST + nameMatch * NAME_BOOST)

    return { result: r, rerankScore }
  })

  // Sort by rerank score descending
  scored.sort((a, b) => b.rerankScore - a.rerankScore)

  // Return top-K, strip internal score fields
  return scored.slice(0, topK).map(({ result }) => result)
}

/** Common English stop words plus generic programming noise words to skip during term overlap */
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'each',
  'every', 'both', 'few', 'more', 'most', 'other', 'some', 'such', 'no',
  'nor', 'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very',
  'just', 'because', 'but', 'and', 'or', 'if', 'while', 'that', 'this',
  'these', 'those', 'it', 'its', 'he', 'she', 'they', 'them', 'their',
  'his', 'her', 'my', 'your', 'our', 'its', 'me', 'you', 'us',
  'what', 'which', 'who', 'whom', 'whose',
  'about', 'up', 'down',
  // Generic programming noise words - appear in nearly every chunk
  'function', 'class', 'method', 'code', 'file', 'return', 'public',
  'private', 'protected', 'static', 'void', 'string', 'number', 'int',
  'boolean', 'const', 'let', 'var', 'import', 'export', 'default',
  'this', 'new', 'throw', 'try', 'catch', 'finally', 'async', 'await',
])