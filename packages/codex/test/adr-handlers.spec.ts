import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { silentLogger, getConfig } = await import('dsh-context-milvus-core')
const { handleSearchAdr, handleSearchAdrByFile, handleListAdrs, handleLoadConstraints } =
  await import('../src/adr-handlers.js')
type HandlerServices = import('../src/handlers.js').HandlerServices

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-adr-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

const SEARCH_HIT = [{
  adrId: 'ADR-0003-retry-queue', docType: 'adr', filePath: 'docs/decisions/ADR-0003.md',
  status: 'active', section: '决策', content: '用重试队列隔离下游故障',
  score: 0.8123, triggerType: 'architecture', codeAnchors: ['src/queue.ts'],
}]

function makeServices(over: Partial<HandlerServices> = {}): HandlerServices {
  return {
    root,
    config: getConfig({ indexRoot: root }),
    milvus: {
      ensureCollection: jest.fn(async () => {}),
      search: jest.fn(async () => []),
      ensureAdrCollection: jest.fn(async () => {}),
      searchAdr: jest.fn(async () => SEARCH_HIT),
    } as any,
    tracker: { getStats: () => ({ totalFiles: 0, totalChunks: 0 }) } as any,
    importResolver: {} as any,
    adr: {
      adrRoot: path.join(root, 'docs', 'decisions'),
      exists: true,
      anchorIndex: { getAdrsForFile: jest.fn(() => ['ADR-0003-retry-queue']), getAll: () => new Map() },
      service: {
        loadAdr: jest.fn(async (id: string) => ({
          frontmatter: { id, status: 'active' },
          sections: { 决策: '用重试队列隔离下游故障，避免雪崩。' },
          rawContent: '', filePath: path.join(root, 'docs', 'decisions', `${id}.md`),
        })),
        listAdrs: jest.fn(async () => ([{
          id: 'ADR-0003-retry-queue', filePath: '/x', status: 'active',
          created: '2026-09-01', updated: '2026-09-01', anchorCount: 1,
          summary: '使用重试队列隔离下游故障', changeType: 'architecture',
        }])),
        getActiveConstraints: jest.fn(async () => ([{
          adrId: 'ADR-0003-retry-queue', adrTitle: '使用重试队列隔离下游故障',
          constraints: ['不得同步调用下游'],
          hiddenConstraints: [{ name: '退避上限', content: '≤ 30s', consequence: '雪崩' }],
          rejectedPatterns: ['无限重试'], status: 'active',
        }])),
      },
      tracker: {}, titles: async () => new Map(),
    } as any,
    ...over,
  }
}

describe('handleSearchAdr', () => {
  it('ensures the ADR collection and defaults to five hits', async () => {
    const s = makeServices()
    const out = await handleSearchAdr(async () => s, silentLogger, { query: '重试', path: root })
    expect(s.milvus.ensureAdrCollection).toHaveBeenCalled()
    expect(s.milvus.searchAdr).toHaveBeenCalledWith('重试', 5, undefined)
    expect(out.results).toHaveLength(1)
  })

  it('maps status and pathPrefix into the Milvus filter', async () => {
    const s = makeServices()
    await handleSearchAdr(async () => s, silentLogger,
      { query: 'q', status: 'active', topK: 9, pathPrefix: 'docs/decisions', path: root })
    expect(s.milvus.searchAdr).toHaveBeenCalledWith('q', 9, { status: 'active', pathPrefix: 'docs/decisions' })
  })

  it('treats status=all as no filter', async () => {
    const s = makeServices()
    await handleSearchAdr(async () => s, silentLogger, { query: 'q', status: 'all', path: root })
    expect(s.milvus.searchAdr).toHaveBeenCalledWith('q', 5, undefined)
  })
})

describe('handleSearchAdrByFile', () => {
  it('resolves a relative file path against the workspace root', async () => {
    const s = makeServices()
    const out = await handleSearchAdrByFile(async () => s, silentLogger,
      { filePath: 'src/queue.ts', path: root })
    // The anchor index stores paths relative to the workspace root.
    expect(s.adr!.anchorIndex.getAdrsForFile).toHaveBeenCalledWith('src/queue.ts')
    expect(out.adrs[0]).toMatchObject({ adrId: 'ADR-0003-retry-queue', status: 'active' })
  })

  it('filters by status', async () => {
    const s = makeServices()
    const out = await handleSearchAdrByFile(async () => s, silentLogger,
      { filePath: 'src/queue.ts', status: 'deprecated', path: root })
    expect(out.adrs).toEqual([])
  })

  it('returns an empty list when no ADR covers the file', async () => {
    const s = makeServices()
    ;(s.adr!.anchorIndex.getAdrsForFile as jest.Mock).mockReturnValue([])
    const out = await handleSearchAdrByFile(async () => s, silentLogger, { filePath: 'src/x.ts', path: root })
    expect(out.adrs).toEqual([])
  })
})

describe('handleListAdrs', () => {
  it('defaults to active with a limit of 100', async () => {
    const s = makeServices()
    const out = await handleListAdrs(async () => s, silentLogger, { path: root })
    expect(s.adr!.service.listAdrs).toHaveBeenCalledWith({ status: 'active', changeType: undefined, limit: 100 })
    expect(out.adrs).toHaveLength(1)
  })

  it('passes changeType and limit through', async () => {
    const s = makeServices()
    await handleListAdrs(async () => s, silentLogger, { status: 'all', changeType: 'refactor', limit: 3, path: root })
    expect(s.adr!.service.listAdrs).toHaveBeenCalledWith({ status: 'all', changeType: 'refactor', limit: 3 })
  })
})

describe('handleLoadConstraints', () => {
  it('omits hidden constraints in summary format', async () => {
    const s = makeServices()
    const out = await handleLoadConstraints(async () => s, silentLogger, { path: root })
    expect(out.constraints[0].hiddenConstraints).toBeUndefined()
    expect(out.constraints[0].constraints).toEqual(['不得同步调用下游'])
  })

  it('includes hidden constraints in full format', async () => {
    const s = makeServices()
    const out = await handleLoadConstraints(async () => s, silentLogger, { format: 'full', path: root })
    expect(out.constraints[0].hiddenConstraints).toHaveLength(1)
  })

  it('filters by a comma separated adrIds list', async () => {
    const s = makeServices()
    const out = await handleLoadConstraints(async () => s, silentLogger, { adrIds: 'ADR-9999-x', path: root })
    expect(out.constraints).toEqual([])
  })
})
