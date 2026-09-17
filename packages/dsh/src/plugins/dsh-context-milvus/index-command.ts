/**
 * Build the paste-ready command that index_code / index_specs hand to the user
 * when they defer a large corpus.
 *
 * The command points at *this* package's bin, resolved from this module's own
 * URL, so it works wherever DSH installed the plugin (profile node_modules,
 * a global install, or a checkout). src/ and dist/ sit at the same depth, so
 * one relative path covers both layouts.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const BIN_RELATIVE = '../../../bin/index.js'

/** Quote a path for a shell command line (double quotes survive spaces). */
function quote(value: string): string {
  return JSON.stringify(value)
}

export function buildIndexCommand(indexRoot: string, options?: { specsOnly?: boolean }): string {
  const binPath = fileURLToPath(new URL(BIN_RELATIVE, import.meta.url))

  const parts = existsSync(binPath)
    ? ['node', quote(binPath)]
    : ['npx', '-p', 'dsh-context-milvus', 'dsh-context-milvus-index']

  parts.push('--root', quote(indexRoot))
  if (options?.specsOnly) parts.push('--specs-only')

  return parts.join(' ')
}
