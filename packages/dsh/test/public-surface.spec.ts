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
})
