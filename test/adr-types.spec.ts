// test/adr-types.spec.ts — config resolution tests
import { jest } from '@jest/globals'
const { getConfig } = await import('../src/plugins/dsh-context-milvus/config.js')

describe('ADR config', () => {
  const OLD_ENV = process.env
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ADR_ENABLED
    delete process.env.ADR_ROOT
    delete process.env.ADR_COLLECTION
    delete process.env.ADR_REINJECT_EVERY
  })
  afterAll(() => { process.env = OLD_ENV })

  it('defaults adrEnabled to true', () => {
    expect(getConfig().adrEnabled).toBe(true)
  })

  it('reads adrRoot from env', () => {
    process.env.ADR_ROOT = 'decisions'
    expect(getConfig().adrRoot).toBe('decisions')
  })

  it('defaults adrCollection to adr_embeddings', () => {
    expect(getConfig().adrCollection).toBe('adr_embeddings')
  })

  it('defaults adrConstraintReinjectEvery to 5', () => {
    expect(getConfig().adrConstraintReinjectEvery).toBe(5)
  })

  it('reads adrConstraintReinjectEvery from env', () => {
    process.env.ADR_REINJECT_EVERY = '10'
    expect(getConfig().adrConstraintReinjectEvery).toBe(10)
  })

  it('Cordis config overrides env', () => {
    process.env.ADR_ENABLED = 'false'
    expect(getConfig({ adrEnabled: true }).adrEnabled).toBe(true)
  })
})