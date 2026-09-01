// test/adr-types.spec.ts — config resolution tests
import { jest } from '@jest/globals'
const { getConfig } = await import('../src/plugins/dsh-context-milvus/config.js')

describe('ADR config', () => {
  it('defaults adrEnabled to false', () => {
    expect(getConfig().adrEnabled).toBe(false)
  })

  it('defaults adrRoot to docs/decisions', () => {
    expect(getConfig().adrRoot).toBe('docs/decisions')
  })

  it('defaults adrCollection to adr_embeddings', () => {
    expect(getConfig().adrCollection).toBe('adr_embeddings')
  })

  it('defaults adrConstraintReinjectEvery to 0 (disabled)', () => {
    expect(getConfig().adrConstraintReinjectEvery).toBe(0)
  })

  it('Cordis config overrides adrEnabled', () => {
    expect(getConfig({ adrEnabled: true }).adrEnabled).toBe(true)
  })

  it('Cordis config overrides adrConstraintReinjectEvery', () => {
    expect(getConfig({ adrConstraintReinjectEvery: 10 }).adrConstraintReinjectEvery).toBe(10)
  })
})