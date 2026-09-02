/**
 * Code relationship analysis — BFS call chain engine and denoising logic.
 *
 * Provides:
 * - findCallers: single-level reference lookup (backward = who references me,
 *   forward = what I reference)
 * - traceChain: BFS chain traversal with cycle prevention
 * - isNoiseSymbol / DEFAULT_STOP_WORDS: denoising for generic symbols
 */

/** Result from a single-level reference lookup */
export interface RelationChunk {
  filePath: string
  content: string
  startLine: number
  endLine: number
  chunkType: string
  name: string
  references?: string[]  // Only populated for forward direction (callees)
}

/** Result of find_callers */
export interface CallersResult {
  chunks: RelationChunk[]
}

/** A node in the BFS call chain */
export interface ChainNode {
  depth: number
  symbol: string
  filePath: string
  startLine: number
  endLine: number
  callers: string[]  // symbols of calling functions at the next level down
}

/** Result of trace_call_chain */
export interface TraceResult {
  chain: ChainNode[]
}

/** Options for traceChain BFS */
export interface TraceOptions {
  direction?: 'backward' | 'forward'
  maxDepth?: number
  maxResults?: number
}

/** Single-level lookup function signature (injected by tools.ts) */
export type FindBySymbol = (
  symbol: string,
  direction: 'backward' | 'forward',
  maxResults: number,
) => Promise<RelationChunk[]>

/** Default stop words — symbols too generic for useful reference analysis */
export const DEFAULT_STOP_WORDS = new Set([
  'data', 'config', 'result', 'process', 'error', 'value', 'item', 'args',
  'options', 'tmp', 'temp', 'key', 'val', 'name', 'type', 'size', 'length',
  'index', 'count', 'total', 'status', 'msg', 'err', 'str', 'num', 'obj',
  'arr', 'fn', 'cb', 'done', 'next', 'promise', 'callback', 'resolve',
  'reject', 'then', 'catch', 'finally',
])

/** Check if a symbol is noise (too generic or too short) */
export function isNoiseSymbol(symbol: string): boolean {
  if (symbol.length <= 1) return true
  if (DEFAULT_STOP_WORDS.has(symbol)) return true
  return false
}

/**
 * Single-level reference lookup.
 * Direction 'backward' = find chunks that reference the given symbol (callers).
 * Direction 'forward' = find chunks whose name matches the symbol, then return their references (callees).
 */
export async function findCallers(
  findBySymbol: FindBySymbol,
  symbol: string,
  direction: 'backward' | 'forward' = 'backward',
  maxResults: number = 20,
): Promise<CallersResult> {
  if (isNoiseSymbol(symbol)) {
    return { chunks: [] }
  }

  const chunks = await findBySymbol(symbol, direction, maxResults)
  return { chunks }
}

/**
 * BFS chain traversal for trace_call_chain.
 * Starts from the entry symbol, expands level by level using findCallers.
 * Uses visited set to prevent cycles.
 */
export async function traceChain(
  findBySymbol: FindBySymbol,
  entry: string,
  options: TraceOptions = {},
): Promise<TraceResult> {
  const direction = options.direction ?? 'backward'
  const maxDepth = options.maxDepth ?? 3
  const maxResults = options.maxResults ?? 10

  if (isNoiseSymbol(entry)) {
    return { chain: [] }
  }

  const visited = new Set<string>()
  const chain: ChainNode[] = []
  let currentLevel: Array<{ symbol: string; depth: number }> = [{ symbol: entry, depth: 0 }]

  while (currentLevel.length > 0 && maxDepth > 0) {
    const nextLevel: Array<{ symbol: string; depth: number }> = []

    for (const item of currentLevel) {
      if (visited.has(item.symbol)) continue
      visited.add(item.symbol)

      const result = await findCallers(findBySymbol, item.symbol, direction, maxResults)
      const callerNames = result.chunks.map(c => c.name).filter(Boolean)

      // The "callers" field: for backward direction, the callers are the
      // chunks that reference this symbol (their names). For forward
      // direction, the callers are the callees (symbols this function calls).
      let uniqueCallers: string[]
      if (direction === 'backward') {
        uniqueCallers = [...new Set(callerNames)]
      } else {
        // Forward: collect references (callees) from the definition chunks
        uniqueCallers = [...new Set(
          result.chunks.flatMap(c => c.references ?? [])
        )]
      }

      chain.push({
        depth: item.depth,
        symbol: item.symbol,
        filePath: result.chunks.length > 0 ? result.chunks[0].filePath : '',
        startLine: result.chunks.length > 0 ? result.chunks[0].startLine : 0,
        endLine: result.chunks.length > 0 ? result.chunks[0].endLine : 0,
        callers: uniqueCallers,
      })

      // Enqueue next level
      if (item.depth < maxDepth - 1) {
        for (const nextSymbol of uniqueCallers) {
          if (!visited.has(nextSymbol) && !isNoiseSymbol(nextSymbol)) {
            nextLevel.push({ symbol: nextSymbol, depth: item.depth + 1 })
          }
        }
      }
    }

    currentLevel = nextLevel
  }

  return { chain }
}