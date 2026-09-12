import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

// The core barrel re-exports milvus-service, which imports the Milvus SDK at
// module load; the SDK is unloadable under Jest ESM, so stub it (see helper).
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { WorkspaceServiceCache } = await import('../src/workspace-services.js')
const { silentLogger } = await import('dsh-context-milvus-core')

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-svc-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('WorkspaceServiceCache', () => {
  it('creates and caches services per workspace root', async () => {
    const cache = new WorkspaceServiceCache(silentLogger)
    const first = await cache.get(root)
    const second = await cache.get(root)
    expect(second).toBe(first)
    expect(first.root).toBe(root)
    expect(first.config.indexRoot).toBe(root)
    expect(cache.size()).toBe(1)
  })

  it('isolates state files per root', async () => {
    const cache = new WorkspaceServiceCache(silentLogger)
    const other = await mkdtemp(path.join(tmpdir(), 'ctx-svc2-'))
    try {
      const a = await cache.get(root)
      const b = await cache.get(other)
      expect(a.config.merkleFilePath).not.toBe(b.config.merkleFilePath)
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })
})
