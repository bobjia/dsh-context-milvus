import type { Logger } from 'dsh-context-milvus-core'

export interface RuntimeContext {
  workspaceRoot: string
  logger: Logger
}

function emit(stream: 'log' | 'warn' | 'error', prefix: string, msg: string, meta?: unknown): void {
  const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`
  console[stream](`${prefix} ${msg}${suffix}`)
}

/**
 * MCP stdio uses stdout for JSON-RPC, so ALL logs must go to stderr.
 * `console.error` writes to stderr; `console.warn` also writes to stderr in Node,
 * but we route everything through error for a single guaranteed sink.
 */
export function createStderrLogger(prefix = '[codex-context-milvus]'): Logger {
  return {
    debug: (m, meta) => emit('error', prefix, m, meta),
    info: (m, meta) => emit('error', prefix, m, meta),
    warn: (m, meta) => emit('error', prefix, m, meta),
    error: (m, meta) => emit('error', prefix, m, meta),
  }
}
