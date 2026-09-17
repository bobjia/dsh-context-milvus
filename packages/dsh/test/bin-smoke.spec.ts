import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../bin/index.js')
// The bin imports the core *package*, whose entry is dist/index.js — so this
// spec needs `npm run build` first, exactly like packages/codex/test/mcp-smoke.spec.ts.
const CORE_BUILT = existsSync(path.resolve(HERE, '../../core/dist/cli.js'))
const maybeIt = CORE_BUILT ? it : it.skip

async function run(args: string[]): Promise<{ code: number | null; out: string; err: string }> {
  const child = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let err = ''
  child.stdout.on('data', (c) => { out += String(c) })
  child.stderr.on('data', (c) => { err += String(c) })
  const [code] = await once(child, 'exit')
  return { code, out, err }
}

describe('dsh-context-milvus-index bin', () => {
  maybeIt('prints usage and exits 0 for --help', async () => {
    const { code, out } = await run(['--help'])
    expect(code).toBe(0)
    expect(out).toContain('用法')
    expect(out).toContain('--specs-only')
  })

  maybeIt('exits 2 for an unknown flag', async () => {
    const { code, err } = await run(['--nope'])
    expect(code).toBe(2)
    expect(err).toContain('未知参数')
  })
})
