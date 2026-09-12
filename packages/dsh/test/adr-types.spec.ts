// test/adr-types.spec.ts — config resolution + AdrChunk/AdrSearchResult docType tests
import { jest } from '@jest/globals'
const { getConfig } = await import('../src/plugins/dsh-context-milvus/config.js')
import type { AdrChunk, AdrSearchResult } from '../src/plugins/dsh-context-milvus/types.js'

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

describe('AdrChunk docType', () => {
  it('accepts docType field with value "adr"', () => {
    const chunk: AdrChunk = {
      filePath: '/test.md',
      adrId: 'ADR-0001',
      docType: 'adr',
      section: 'goal',
      content: 'test',
      startLine: 1,
      endLine: 5,
      status: 'active',
      codeAnchors: ['src/a.ts'],
      triggerType: 'refactor',
    }
    expect(chunk.docType).toBe('adr')
  })

  it('accepts docType field with value "spec"', () => {
    const chunk: AdrChunk = {
      filePath: '/spec.md',
      adrId: 'SPEC-0001',
      docType: 'spec',
      section: 'overview',
      content: 'test',
      startLine: 1,
      endLine: 5,
      status: 'active',
      codeAnchors: [],
      triggerType: 'new_feature',
    }
    expect(chunk.docType).toBe('spec')
  })

  it('accepts docType field with value "plan"', () => {
    const chunk: AdrChunk = {
      filePath: '/plan.md',
      adrId: 'PLAN-0001',
      docType: 'plan',
      section: 'steps',
      content: 'test',
      startLine: 1,
      endLine: 5,
      status: 'active',
      codeAnchors: [],
      triggerType: 'architecture',
    }
    expect(chunk.docType).toBe('plan')
  })
})

describe('AdrSearchResult docType', () => {
  it('accepts docType field with value "adr"', () => {
    const result: AdrSearchResult = {
      adrId: 'ADR-0001',
      docType: 'adr',
      filePath: '/test.md',
      status: 'active',
      section: 'goal',
      content: 'test',
      score: 0.95,
      triggerType: 'refactor',
      codeAnchors: ['src/a.ts'],
    }
    expect(result.docType).toBe('adr')
  })

  it('accepts docType field with value "spec"', () => {
    const result: AdrSearchResult = {
      adrId: 'SPEC-0001',
      docType: 'spec',
      filePath: '/spec.md',
      status: 'active',
      section: 'overview',
      content: 'test',
      score: 0.85,
      triggerType: 'new_feature',
      codeAnchors: [],
    }
    expect(result.docType).toBe('spec')
  })
})