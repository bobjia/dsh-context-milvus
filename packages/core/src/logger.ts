/** Minimal logging port so adapters can redirect output (DSH: console, Codex MCP: stderr). */
export interface Logger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}

function write(stream: 'log' | 'warn' | 'error', msg: string, meta?: unknown): void {
  const suffix = meta === undefined ? '' : ` ${JSON.stringify(meta)}`
  console[stream](`[dsh-context-milvus-core] ${msg}${suffix}`)
}

/** Default logger used by the DSH adapter and tests. */
export const consoleLogger: Logger = {
  debug: (m, meta) => write('log', m, meta),
  info: (m, meta) => write('log', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
}

/** No-op logger for tests that assert on other behavior. */
export const silentLogger: Logger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
}
