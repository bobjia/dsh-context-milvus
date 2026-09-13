import { getConfig } from '../src/config.js'

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
