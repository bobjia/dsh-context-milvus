import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src/plugins/dsh-context-milvus')

const EXPECTED_TOOLS = [
  'search_code', 'index_code', 'index_status', 'find_callers', 'trace_call_chain',
  'search_adr', 'search_adr_by_file', 'create_adr', 'update_adr', 'list_adrs',
  'load_constraints', 'check_adr_consistency', 'index_specs',
].sort()

function toolNames(file: string): string[] {
  const text = readFileSync(path.join(SRC, file), 'utf-8')
  return [...text.matchAll(/name:\s*'([a-z_]+)'/g)].map(m => m[1])
}

const EXPECTED_CONFIG_KEYS = [
  'milvusAddress', 'milvusToken', 'milvusCollection', 'milvusDim',
  'embeddingEndpoint', 'embeddingApiKey', 'embeddingModel', 'indexRoot',
  'indexExtensions', 'hybridMode', 'bm25RrfK', 'chunkContextLines',
  'queryExpansion', 'rerankEnabled', 'rerankMultiplier', 'indexIgnoreDirs',
  'merkleFilePath', 'ignorePatterns', 'adrEnabled', 'adrRoot', 'adrCollection',
  'adrConstraintReinjectEvery', 'adrSystemPrompt', 'specRoot', 'planRoot',
  'telemetryEnabled', 'telemetryFile',
].sort()

describe('dsh public surface', () => {
  it('never hard-depends on host-provided @deepseek-ai framework packages', () => {
    // Framework packages are provided by the DSH host at runtime (the same way
    // cordis/dsh-tools/dsh-settings already are). A hard dependency pins an
    // ancient npm "latest" (dsh-llm@0.0.1-rc.1) which then shadows the host's
    // modern copy for every other plugin under hoisted module linking.
    const pkg = JSON.parse(
      readFileSync(path.resolve(HERE, '../package.json'), 'utf-8'),
    )
    const hardDeps = Object.keys(pkg.dependencies ?? {}).filter(d =>
      d.startsWith('@deepseek-ai/'),
    )
    expect(hardDeps).toEqual([])
    expect(pkg.peerDependencies?.['@deepseek-ai/dsh-llm']).toBeTruthy()
    expect(
      pkg.peerDependenciesMeta?.['@deepseek-ai/dsh-llm']?.optional,
    ).toBe(true)
  })

  it('keeps all 13 tool names', () => {
    const names = [...toolNames('tools.ts'), ...toolNames('adr-tools.ts')]
    expect([...new Set(names)].sort()).toEqual(EXPECTED_TOOLS)
  })

  it('keeps all config keys', () => {
    const text = readFileSync(path.join(SRC, 'index.ts'), 'utf-8')
    // Note the [a-zA-Z0-9] class: `bm25RrfK` contains digits, so a letters-only
    // class would silently drop it from the frozen contract.
    const keys = [...text.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map(m => m[1])
    expect([...new Set(keys)].sort()).toEqual(EXPECTED_CONFIG_KEYS)
  })

  it('marks every config field volatile, or the GUI drops it from the form', () => {
    // dsh-settings ≥0.1.7 lists a namespace only when its schema has volatile
    // fields, and hides/refuses non-volatile ones. A field added without
    // .volatile() would silently vanish from Settings → Plugins.
    const text = readFileSync(path.join(SRC, 'index.ts'), 'utf-8')
    const start = text.indexOf('export const Config = z.object({')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = text.indexOf('\n})', start)
    expect(end).toBeGreaterThan(start)

    // One chunk per field, split at each `  key: z.` anchor.
    const chunks = text.slice(start, end).split(/\n(?=  [a-zA-Z][a-zA-Z0-9]*: z\.)/).slice(1)
    expect(chunks.length).toBe(EXPECTED_CONFIG_KEYS.length)

    const notVolatile = chunks
      .filter(c => !c.includes('.volatile()'))
      .map(c => c.match(/^  ([a-zA-Z][a-zA-Z0-9]*):/)![1])
    expect(notVolatile).toEqual([])
  })
})
