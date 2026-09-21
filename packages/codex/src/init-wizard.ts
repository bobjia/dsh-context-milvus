import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'

export interface InitOptions {
  milvusAddress: string
  embeddingEndpoint: string
  embeddingModel: string
  workspaceRoot: string
  milvusToken?: string
  embeddingApiKey?: string
  /** Absolute path to a local bin/mcp.js — emit command="<node>"/args=[path] instead of the npx form. */
  localMcpPath?: string
}

export const SECTION_HEADER = '[mcp_servers.context-milvus]'
const SECTION_ENV_HEADER = '[mcp_servers.context-milvus.env]'

export function renderMcpSection(options: InitOptions): string {
  const env: string[] = [
    `MILVUS_ADDRESS = ${JSON.stringify(options.milvusAddress)}`,
    `EMBEDDING_ENDPOINT = ${JSON.stringify(options.embeddingEndpoint)}`,
    `EMBEDDING_MODEL = ${JSON.stringify(options.embeddingModel)}`,
    `CONTEXT_MILVUS_WORKSPACE = ${JSON.stringify(options.workspaceRoot)}`,
  ]
  if (options.milvusToken) env.push(`MILVUS_TOKEN = ${JSON.stringify(options.milvusToken)}`)
  if (options.embeddingApiKey) env.push(`EMBEDDING_API_KEY = ${JSON.stringify(options.embeddingApiKey)}`)

  // Offline/local installs skip the registry: point straight at a local mcp.js,
  // running under the node binary that started init (full path, so no PATH
  // reliance). JSON.stringify keeps the path a valid TOML basic string — on
  // Windows a backslash becomes `\\`.
  const command = options.localMcpPath
    ? `command = ${JSON.stringify(process.execPath)}`
    : 'command = "npx"'
  const args = options.localMcpPath
    ? `args = [${JSON.stringify(options.localMcpPath)}]`
    : 'args = ["-y", "codex-context-milvus", "mcp"]'

  return [
    SECTION_HEADER,
    command,
    args,
    'enabled = true',
    '',
    SECTION_ENV_HEADER,
    ...env,
    '',
  ].join('\n')
}

/** Extract a top-level section block: from its header to the next top-level header. */
function extractSection(text: string, header: string): { start: number; end: number } | null {
  const lines = text.split('\n')
  const start = lines.findIndex(l => l.trim() === header)
  if (start === -1) return null
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    // A top-level table header that is not our own env sub-table. Headers that
    // mention context-milvus belong to this block, so the env sub-table that
    // follows is swallowed together with it.
    if (/^\s*\[/.test(line) && !line.includes('context-milvus')) { end = i; break }
  }
  return { start, end }
}

export function upsertMcpSection(existing: string, options: InitOptions): { toml: string; changed: boolean } {
  const block = renderMcpSection(options)
  const found = extractSection(existing, SECTION_HEADER)

  if (!found) {
    const base = existing.length === 0 ? '' : existing.replace(/\n*$/, '\n\n')
    return { toml: base + block, changed: true }
  }

  const lines = existing.split('\n')
  const before = lines.slice(0, found.start).join('\n')
  const after = lines.slice(found.end).join('\n')
  const next = [before.replace(/\n*$/, ''), block.trimEnd(), after.replace(/^\n*/, '')]
    .filter(part => part.length > 0)
    .join('\n\n') + '\n'

  return { toml: next, changed: next !== existing }
}

export async function writeProjectConfig(
  projectRoot: string,
  options: InitOptions,
): Promise<{ path: string; backup?: string; changed: boolean }> {
  const dir = path.join(projectRoot, '.codex')
  const target = path.join(dir, 'config.toml')
  await mkdir(dir, { recursive: true })

  const existing = existsSync(target) ? await readFile(target, 'utf-8') : ''
  const { toml, changed } = upsertMcpSection(existing, options)

  let backup: string | undefined
  if (changed && existsSync(target)) {
    backup = `${target}.bak`
    await copyFile(target, backup)
  }
  if (changed) await writeFile(target, toml, 'utf-8')
  return { path: target, backup, changed }
}
