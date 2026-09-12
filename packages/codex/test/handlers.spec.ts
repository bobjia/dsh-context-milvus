import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

// handlers.ts imports the core barrel (runIndex, findCallers, ...), which
// loads the Milvus SDK at module load — stub it (see helper for why).
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { silentLogger, getConfig } = await import('dsh-context-milvus-core')
const { handleSearchCode, handleIndexCode, handleIndexStatus,
        handleFindCallers, handleTraceCallChain } = await import('../src/handlers.js')
type HandlerServices = import('../src/handlers.js').HandlerServices

let root: string
const cwdBefore = process.cwd()
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-h-')) })
afterEach(async () => {
  process.chdir(cwdBefore)
  await rm(root, { recursive: true, force: true })
})

function makeServices(): HandlerServices {
  return {
    root,
    // A real PluginConfig: runIndex spreads config.ignorePatterns and reads
    // config.embedding, so a hand-rolled partial object is not enough.
    config: getConfig({ indexRoot: root, indexExtensions: '.ts' }),
    milvus: {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(async () => ([{
        filePath: path.join(root, 'a.ts'), content: 'code', score: 0.5,
        language: 'typescript', startLine: 1, endLine: 2, name: 'a', chunkType: 'function',
      }])),
    } as any,
    tracker: { getStats: () => ({ totalFiles: 1, totalChunks: 1 }),
               getLastIndexedTimestamp: () => Date.now(),
               computeDelta: () => ({ toIndex: [], toRemove: [], unchanged: [] }),
               load: async () => true, save: async () => {} } as any,
    importResolver: { save: async () => {}, removeFile: () => {} } as any,
  }
}

describe('handleSearchCode', () => {
  it('scopes the search to the workspace root by default', async () => {
    // The handler discovers the workspace from cwd, exactly like the MCP
    // server does when Codex launches it in the session directory.
    process.chdir(root)
    const services = makeServices()
    const out = await handleSearchCode(async () => services, silentLogger, { query: 'auth' })
    expect(services.milvus.search).toHaveBeenCalledWith('auth', 5, root)
    expect(out.root).toBe(root)
    expect(out.source).toBe('cwd')
    expect(out.results).toHaveLength(1)
  })

  it('joins pathPrefix onto the workspace root', async () => {
    const services = makeServices()
    await handleSearchCode(async () => services, silentLogger,
      { query: 'auth', topK: 3, path: root, pathPrefix: 'src/api' })
    expect(services.milvus.search).toHaveBeenCalledWith('auth', 3, path.join(root, 'src/api'))
  })
})

describe('handleIndexStatus', () => {
  it('returns tracker stats', async () => {
    const services = makeServices()
    const out = await handleIndexStatus(async () => services, silentLogger, { path: root })
    expect(out.status.totalFiles).toBe(1)
    expect(out.root).toBe(root)
  })
})

describe('handleIndexCode', () => {
  it('runs an incremental index by default', async () => {
    const services = makeServices()
    const out = await handleIndexCode(async () => services, silentLogger, { path: root })
    expect(out.result.filesSkipped).toBeGreaterThanOrEqual(0)
  })
})

describe('handleFindCallers', () => {
  it('warns and degrades when the import map is not loaded', async () => {
    const services = makeServices()
    services.importResolver = { isLoaded: () => false } as any
    services.milvus = {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(),
      queryByReference: jest.fn(async () => ([{
        filePath: path.join(root, 'a.ts'), content: 'c', startLine: 1, endLine: 2,
        chunkType: 'function', name: 'caller',
      }])),
      queryByName: jest.fn(async () => []),
    } as any
    const out = await handleFindCallers(async () => services, silentLogger, { symbol: 'parseConfig' })
    expect(out.result.chunks).toHaveLength(1)
    expect(out.result.warning).toContain('import map')
  })
})

describe('handleTraceCallChain', () => {
  it('returns a chain payload', async () => {
    const services = makeServices()
    services.importResolver = { isLoaded: () => false } as any
    services.milvus = {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(),
      queryByReference: jest.fn(async () => []),
      queryByName: jest.fn(async () => []),
    } as any
    const out = await handleTraceCallChain(async () => services, silentLogger, { entry: 'run' })
    // core's traceChain always seeds a depth-0 node for the entry symbol, even
    // when nothing references it; only its callers list stays empty.
    expect(out.result.chain).toEqual([
      { depth: 0, symbol: 'run', filePath: '', startLine: 0, endLine: 0, callers: [] },
    ])
  })
})
