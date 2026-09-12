import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { AdrError, writesEnabled, assertWritesEnabled, requireExistingAdr } =
  await import('../src/adr-gate.js')

const KEY = 'CONTEXT_MILVUS_ADR_WRITE'
const saved = process.env[KEY]
afterEach(() => {
  if (saved === undefined) delete process.env[KEY]
  else process.env[KEY] = saved
})

describe('ADR write gate', () => {
  it('is closed by default', () => {
    delete process.env[KEY]
    expect(writesEnabled()).toBe(false)
    expect(() => assertWritesEnabled('create_adr')).toThrow(AdrError)
    try {
      assertWritesEnabled('create_adr')
    } catch (e) {
      expect((e as AdrError).code).toBe('E_ADR_WRITE_DISABLED')
      // The message must name the switch: an agent can only self-report if it
      // can see exactly what to change.
      expect((e as Error).message).toContain(KEY)
    }
  })

  it.each([['1'], ['true'], ['TRUE'], ['yes'], ['on']])('opens for %s', (raw) => {
    process.env[KEY] = raw
    expect(writesEnabled()).toBe(true)
    expect(() => assertWritesEnabled('create_adr')).not.toThrow()
  })

  it.each([['0'], ['false'], ['no'], ['']])('stays closed for %s', (raw) => {
    process.env[KEY] = raw
    expect(writesEnabled()).toBe(false)
  })
})

describe('requireExistingAdr', () => {
  it('rejects a bundle whose ADR directory is absent', () => {
    expect(() => requireExistingAdr({ exists: false } as any)).toThrow(AdrError)
    try {
      requireExistingAdr({ exists: false } as any)
    } catch (e) {
      expect((e as AdrError).code).toBe('E_ADR_NOT_INITIALIZED')
      expect((e as Error).message).toContain('ADR_ROOT')
    }
  })

  it('rejects a missing bundle without creating anything', () => {
    expect(() => requireExistingAdr(undefined)).toThrow(AdrError)
  })

  it('passes a usable bundle through', () => {
    const bundle = { exists: true, adrRoot: '/x' } as any
    expect(requireExistingAdr(bundle)).toBe(bundle)
  })
})
