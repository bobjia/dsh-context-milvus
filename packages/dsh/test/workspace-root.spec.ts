import { jest } from '@jest/globals'

// core barrel pulls in Milvus SDK at import time; Jest's ESM runtime can't load it
// (uuid is ESM-only — see CLAUDE.md). This spec never touches Milvus.
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { getConfig } = await import('dsh-context-milvus-core')
import type { PluginConfig } from 'dsh-context-milvus-core'

const { resolveWorkspaceRoot } = await import(
  '../src/plugins/dsh-context-milvus/workspace-root.js'
)

// Build via getConfig() (not hand-written) so the fixture tracks PluginConfig
// shape automatically if new fields are added. indexRoot is forced to '' so
// the "all upstream levels empty" tests can reach the startupCwd / process.cwd()
// fallbacks — getConfig defaults indexRoot to process.cwd().
const cfg: PluginConfig = getConfig({ indexRoot: '' })

const execWith = (cwd?: string) =>
  cwd === undefined ? undefined : { agent: { session: { header: { cwd } } } }

describe('resolveWorkspaceRoot', () => {
  test('explicit path wins', () => {
    expect(resolveWorkspaceRoot(cfg, undefined, '/home/u', '/explicit')).toBe('/explicit')
  })

  test('session cwd used when explicit path missing', () => {
    expect(resolveWorkspaceRoot(cfg, execWith('/proj'), '/home/u')).toBe('/proj')
  })

  test('config.indexRoot used when explicit and session missing', () => {
    const c = { ...cfg, indexRoot: '/repo' }
    expect(resolveWorkspaceRoot(c, undefined, '/home/u')).toBe('/repo')
  })

  test('startupCwd used as final fallback when all else empty', () => {
    expect(resolveWorkspaceRoot(cfg, undefined, '/home/u')).toBe('/home/u')
  })

  test('process.cwd() used when startupCwd is empty too', () => {
    const before = process.cwd()
    expect(resolveWorkspaceRoot(cfg, undefined, '')).toBe(before)
  })

  test('explicit path beats session cwd', () => {
    expect(resolveWorkspaceRoot(cfg, execWith('/proj'), '/home/u', '/force')).toBe('/force')
  })
})
