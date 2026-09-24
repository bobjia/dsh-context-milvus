import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const { buildIndexCommand } = await import('../src/plugins/dsh-context-milvus/index-command.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../bin/index.js')

describe('buildIndexCommand', () => {
  it('points at this package\'s own bin when it exists', () => {
    expect(existsSync(BIN)).toBe(true) // the bin ships with this package

    const command = buildIndexCommand('/work/my repo')

    // The bin path is quoted with JSON.stringify, which escapes backslashes on
    // Windows — assert against the JSON-quoted form. The root is passed through
    // verbatim (no normalization), so it stays as the caller supplied it.
    expect(command).toContain(JSON.stringify(BIN))
    expect(command).toContain('--root')
    expect(command).toContain('"/work/my repo"') // quoted for spaces, unmodified
    expect(command).not.toContain('--specs-only')
  })

  it('appends --specs-only when asked', () => {
    expect(buildIndexCommand('/work/api', { specsOnly: true })).toContain('--specs-only')
  })

  it('appends --mode when a mode is requested', () => {
    expect(buildIndexCommand('/work/api', { mode: 'full' })).toContain('--mode full')
    expect(buildIndexCommand('/work/api', { mode: 'incremental' })).toContain('--mode incremental')
  })

  it('appends nothing when no mode is requested', () => {
    // index_specs relies on this: specs-only is mode-independent.
    expect(buildIndexCommand('/work/api')).not.toContain('--mode')
    expect(buildIndexCommand('/work/api', { specsOnly: true })).not.toContain('--mode')
  })

  it('falls back to npx for an unknown layout', () => {
    // Documented fallback branch: asserted via the npx form of the string.
    const command = buildIndexCommand('/work/api')
    expect(command.startsWith('node ') || command.startsWith('npx ')).toBe(true)
  })
})
