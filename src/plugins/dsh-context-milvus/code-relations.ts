/**
 * Code relationship analysis — BFS call chain engine and denoising logic.
 *
 * Provides:
 * - findCallers: single-level reference lookup (backward = who references me,
 *   forward = what I reference)
 * - traceChain: BFS chain traversal with cycle prevention
 * - isNoiseSymbol / DEFAULT_STOP_WORDS: denoising for generic symbols
 */

import type { ResolutionInfo } from './types.js'

/** Result from a single-level reference lookup */
export interface RelationChunk {
  filePath: string
  content: string
  startLine: number
  endLine: number
  chunkType: string
  name: string
  references?: string[]  // Only populated for forward direction (callees)
  resolution?: ResolutionInfo  // NEW: cross-file resolution info
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

/** Options for findCallers with import resolution */
export interface FindCallersOptions {
  maxResults?: number
  sourceFile?: string        // NEW: explicit file qualification
  resolver?: {               // NEW: import resolver interface
    resolve: (filePath: string, symbol: string) => { target: string; exportedAs: string } | null
    getExports: (filePath: string) => string[]
  }
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
  options: FindCallersOptions = {},
): Promise<CallersResult> {
  const maxResults = options.maxResults ?? 20
  const resolver = options.resolver

  if (isNoiseSymbol(symbol)) {
    return { chunks: [] }
  }

  const chunks = await findBySymbol(symbol, direction, maxResults)

  // Apply import resolution if available
  if (resolver) {
    const filtered: RelationChunk[] = []

    for (const chunk of chunks) {
      // Try to resolve the symbol
      const entry = resolver.resolve(chunk.filePath, symbol)

      if (entry) {
        // Resolved: symbol is imported from another file
        if (options.sourceFile && entry.target !== options.sourceFile) {
          continue  // Does not match the requested source file
        }
        chunk.resolution = {
          status: 'resolved',
          targetFile: entry.target,
          exportedAs: entry.exportedAs,
        }
        filtered.push(chunk)
      } else {
        // Check if the symbol is defined in the same file (exports contain it)
        const exports = resolver.getExports(chunk.filePath)
        const isLocal = exports.includes(symbol) || chunk.name === symbol

        if (isLocal) {
          if (options.sourceFile && chunk.filePath !== options.sourceFile) {
            continue  // Local call, but not from the requested file
          }
          chunk.resolution = { status: 'local' }
          filtered.push(chunk)
        } else {
          // Unresolved: keep as fallback
          if (options.sourceFile) {
            continue  // Can't verify, exclude
          }
          chunk.resolution = { status: 'unresolved' }
          filtered.push(chunk)
        }
      }
    }

    return { chunks: filtered }
  }

  return { chunks }
}

/**
 * BFS chain traversal for trace_call_chain.
 * Starts from the entry symbol, expands level by level using findCallers.
 * Uses composite key (filePath:symbol) for visited set to prevent cycles.
 */
export async function traceChain(
  findBySymbol: FindBySymbol,
  entry: string,
  options: TraceOptions & {
    resolver?: {
      resolve: (filePath: string, symbol: string) => { target: string; exportedAs: string } | null
      getExports: (filePath: string) => string[]
    }
  } = {},
): Promise<TraceResult> {
  const direction = options.direction ?? 'backward'
  const maxDepth = options.maxDepth ?? 3
  const maxResults = options.maxResults ?? 10
  const resolver = options.resolver

  if (isNoiseSymbol(entry)) {
    return { chain: [] }
  }

  // Use composite key: filePath:symbol for visited set
  const visited = new Set<string>()
  const chain: ChainNode[] = []
  // Each level item carries: symbol, filePath (for composite key), depth
  let currentLevel: Array<{ symbol: string; filePath: string; depth: number }> = [
    { symbol: entry, filePath: '', depth: 0 },
  ]

  while (currentLevel.length > 0 && maxDepth > 0) {
    const nextLevel: Array<{ symbol: string; filePath: string; depth: number }> = []

    for (const item of currentLevel) {
      const compositeKey = item.filePath ? `${item.filePath}:${item.symbol}` : item.symbol
      if (visited.has(compositeKey)) continue
      visited.add(compositeKey)

      const result = await findCallers(findBySymbol, item.symbol, direction, { maxResults, resolver })

      // Build callers list with composite keys for next level
      const callers: string[] = []
      for (const chunk of result.chunks) {
        // For backward: the caller is the chunk's name
        // For forward: the caller is the resolved reference
        if (direction === 'backward') {
          const callerComposite = chunk.filePath ? `${chunk.filePath}:${chunk.name}` : chunk.name
          callers.push(callerComposite)
        } else {
          // Forward: collect references (callees) from the definition chunks
          for (const ref of chunk.references ?? []) {
            callers.push(ref)
          }
        }
      }

      chain.push({
        depth: item.depth,
        symbol: item.symbol,
        filePath: result.chunks.length > 0 ? result.chunks[0].filePath : item.filePath,
        startLine: result.chunks.length > 0 ? result.chunks[0].startLine : 0,
        endLine: result.chunks.length > 0 ? result.chunks[0].endLine : 0,
        callers,
      })

      // Enqueue next level
      if (item.depth < maxDepth - 1) {
        for (const callerComposite of callers) {
          if (!visited.has(callerComposite) && !isNoiseSymbol(callerComposite.split(':').pop()!)) {
            const [fp, sym] = callerComposite.includes(':')
              ? [callerComposite.split(':')[0], callerComposite.split(':').slice(1).join(':')]
              : ['', callerComposite]
            nextLevel.push({ symbol: sym, filePath: fp, depth: item.depth + 1 })
          }
        }
      }
    }

    currentLevel = nextLevel
  }

  return { chain }
}