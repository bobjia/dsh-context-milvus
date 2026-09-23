import { getConfig, deriveMerkleFilePath } from '../src/config.js'
import path from 'path'
import os from 'os'

const KEYS = ['ADR_ENABLED', 'ADR_ROOT', 'ADR_COLLECTION']
const saved: Record<string, string | undefined> = {}

beforeEach(() => {
  for (const k of KEYS) { saved[k] = process.env[k]; delete process.env[k] }
})
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('ADR config resolution', () => {
  it('defaults ADR off with stock paths when nothing is configured', () => {
    const c = getConfig()
    expect(c.adrEnabled).toBe(false)
    expect(c.adrRoot).toBe('docs/decisions')
    expect(c.adrCollection).toBe('adr_embeddings')
  })

  it.each([['1'], ['true'], ['TRUE'], ['yes'], ['on']])('reads ADR_ENABLED=%s as enabled', (raw) => {
    process.env.ADR_ENABLED = raw
    expect(getConfig().adrEnabled).toBe(true)
  })

  it.each([['0'], ['false'], ['off'], ['']])('reads ADR_ENABLED=%s as disabled', (raw) => {
    process.env.ADR_ENABLED = raw
    expect(getConfig().adrEnabled).toBe(false)
  })

  it('reads ADR_ROOT and ADR_COLLECTION from the environment', () => {
    process.env.ADR_ROOT = 'adr'
    process.env.ADR_COLLECTION = 'team_adr_embeddings'
    const c = getConfig()
    expect(c.adrRoot).toBe('adr')
    expect(c.adrCollection).toBe('team_adr_embeddings')
  })

  it('lets explicit overrides win over the environment', () => {
    process.env.ADR_ENABLED = 'true'
    process.env.ADR_ROOT = 'from-env'
    const c = getConfig({ adrEnabled: false, adrRoot: 'from-overrides' })
    expect(c.adrEnabled).toBe(false)
    expect(c.adrRoot).toBe('from-overrides')
  })

  it('keeps DSH behaviour untouched: an absent env var is not a value', () => {
    // DSH passes a config object without ADR fields; nothing must change there.
    expect(getConfig({ indexRoot: '/tmp/x' }).adrEnabled).toBe(false)
  })
})

describe('empty-string path fields fall back to their derived defaults', () => {
  let savedMerkle: string | undefined
  beforeEach(() => {
    savedMerkle = process.env.MERKLE_FILE_PATH
    delete process.env.MERKLE_FILE_PATH
  })
  afterEach(() => {
    if (savedMerkle === undefined) delete process.env.MERKLE_FILE_PATH
    else process.env.MERKLE_FILE_PATH = savedMerkle
  })

  it('merkleFilePath: an explicit empty string uses the derived per-workspace path', () => {
    const c = getConfig({ indexRoot: '/tmp/ws', merkleFilePath: '' })
    expect(c.merkleFilePath).toBe(deriveMerkleFilePath('/tmp/ws'))
    expect(c.merkleFilePath).not.toBe('')
  })

  it('merkleFilePath: an empty MERKLE_FILE_PATH env var also falls back', () => {
    process.env.MERKLE_FILE_PATH = ''
    expect(getConfig({ indexRoot: '/tmp/ws' }).merkleFilePath).toBe(deriveMerkleFilePath('/tmp/ws'))
  })

  it('telemetryFile: an explicit empty string uses the home default', () => {
    const c = getConfig({ telemetryFile: '' })
    expect(c.telemetryFile).toBe(path.join(os.homedir(), '.milvus-index', 'telemetry.jsonl'))
    expect(c.telemetryFile).not.toBe('')
  })

  it('real paths still win over the derived defaults', () => {
    expect(getConfig({ indexRoot: '/tmp/ws', merkleFilePath: '/tmp/custom.json' }).merkleFilePath).toBe('/tmp/custom.json')
    expect(getConfig({ telemetryFile: '/tmp/t.jsonl' }).telemetryFile).toBe('/tmp/t.jsonl')
  })
})
