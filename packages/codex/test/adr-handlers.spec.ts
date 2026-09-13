import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { jest } from '@jest/globals'
import { milvusSdkMockExports } from './helpers/milvus-sdk-mock.js'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', milvusSdkMockExports)

const { silentLogger, getConfig } = await import('dsh-context-milvus-core')
const {
  handleSearchAdr, handleSearchAdrByFile, handleListAdrs, handleLoadConstraints,
  handleCreateAdr, handleUpdateAdr, handleCheckAdrConsistency, handleIndexSpecs,
} = await import('../src/adr-handlers.js')

const WRITE = 'CONTEXT_MILVUS_ADR_WRITE'
type HandlerServices = import('../src/handlers.js').HandlerServices

let root: string
beforeEach(async () => { root = await mkdtemp(path.join(tmpdir(), 'ctx-adr-')) })
afterEach(async () => { delete process.env[WRITE]; await rm(root, { recursive: true, force: true }) })

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
        createAdr: jest.fn(async () => ({ id: 'ADR-0001-x', filePath: '/x' })),
        updateAdr: jest.fn(async (id: string) => ({ id, filePath: '/x' })),
        removeAnchorsForFile: jest.fn(async () => false),
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

describe('handleCreateAdr', () => {
  it('refuses to write unless the write switch is on', async () => {
    const s = makeServices()
    const before = (s.adr!.service.createAdr as jest.Mock).mock.calls.length
    await expect(handleCreateAdr(async () => s, silentLogger, { title: 'x', path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
    expect((s.adr!.service.createAdr as jest.Mock).mock.calls.length).toBe(before)
  })

  it('creates and re-indexes once the switch is on', async () => {
    process.env[WRITE] = 'true'
    const s = makeServices()
    ;(s.adr!.service.createAdr as jest.Mock).mockResolvedValue({ id: 'ADR-0004-x', filePath: '/x/ADR-0004-x.md' })
    const out = await handleCreateAdr(async () => s, silentLogger,
      { title: 'x', requirement: 'r', changeType: 'refactor', path: root })
    expect(s.adr!.service.createAdr).toHaveBeenCalledWith({
      title: 'x', requirement: 'r', changeType: 'refactor', supersedes: undefined, content: undefined,
    })
    expect(out.adr.adrId).toBe('ADR-0004-x')
  })

  it('refuses when the ADR directory is missing', async () => {
    process.env[WRITE] = 'true'
    const s = makeServices()
    ;(s.adr as any).exists = false
    await expect(handleCreateAdr(async () => s, silentLogger, { title: 'x', path: root }))
      .rejects.toThrow(/ADR_ROOT/)
    expect(s.adr!.service.createAdr).not.toHaveBeenCalled()
  })
})

describe('handleUpdateAdr', () => {
  it('is gated the same way as create', async () => {
    const s = makeServices()
    await expect(handleUpdateAdr(async () => s, silentLogger, { adrId: 'ADR-0003-retry-queue', path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
    expect(s.adr!.service.updateAdr).not.toHaveBeenCalled()
  })

  it('maps camelCase args onto UpdateAdrParams', async () => {
    process.env[WRITE] = 'true'
    const s = makeServices()
    ;(s.adr!.service.updateAdr as jest.Mock).mockResolvedValue({ id: 'ADR-0003-retry-queue', filePath: '/x' })
    await handleUpdateAdr(async () => s, silentLogger,
      { adrId: 'ADR-0003-retry-queue', status: 'superseded', supersededBy: 'ADR-0009-y', merge: true, path: root })
    expect(s.adr!.service.updateAdr).toHaveBeenCalledWith('ADR-0003-retry-queue', {
      content: undefined, status: 'superseded', supersededBy: 'ADR-0009-y', merge: true,
    })
  })
})

describe('handleCheckAdrConsistency', () => {
  function withAnchors(s: HandlerServices, entries: Array<[string, string[]]>) {
    ;(s.adr as any).anchorIndex.getAll = () => new Map(entries)
  }

  it('reports a missing file as a stale anchor without writing', async () => {
    const s = makeServices()
    withAnchors(s, [['src/gone.ts', ['ADR-0003-retry-queue']]])
    const out = await handleCheckAdrConsistency(async () => s, silentLogger, { path: root })
    expect(out.report.staleAnchors).toEqual([
      { adrId: 'ADR-0003-retry-queue', file: 'src/gone.ts', issue: '文件已不存在' },
    ])
    expect(out.report.fixedAnchors).toEqual([])
    expect(s.adr!.service.removeAnchorsForFile).not.toHaveBeenCalled()
  })

  it('does not write even when fix is requested, unless the switch is on', async () => {
    const s = makeServices()
    withAnchors(s, [['src/gone.ts', ['ADR-0003-retry-queue']]])
    await expect(handleCheckAdrConsistency(async () => s, silentLogger, { fix: true, path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
    expect(s.adr!.service.removeAnchorsForFile).not.toHaveBeenCalled()
  })

  it('strips the stale anchor when fix is allowed', async () => {
    process.env[WRITE] = 'true'
    const s = makeServices()
    withAnchors(s, [['src/gone.ts', ['ADR-0003-retry-queue']]])
    ;(s.adr!.service.removeAnchorsForFile as jest.Mock).mockResolvedValue(true)
    const out = await handleCheckAdrConsistency(async () => s, silentLogger, { fix: true, path: root })
    expect(s.adr!.service.removeAnchorsForFile).toHaveBeenCalledWith('ADR-0003-retry-queue', 'src/gone.ts')
    expect(out.report.fixedAnchors).toEqual([{ adrId: 'ADR-0003-retry-queue', file: 'src/gone.ts' }])
  })

  it('flags an untracked file as uncovered', async () => {
    const s = makeServices()
    withAnchors(s, [['src/a.ts', ['ADR-0003-retry-queue']]])
    const out = await handleCheckAdrConsistency(async () => s, silentLogger,
      { filePath: 'src/other.ts', path: root })
    expect(out.report.uncoveredChanges).toEqual([
      { adrId: 'N/A', file: 'src/other.ts', status: 'uncovered' },
    ])
  })
})

describe('handleIndexSpecs', () => {
  it('is safe by default: a missing scan root yields an empty preview', async () => {
    const s = makeServices()
    const out = await handleIndexSpecs(async () => s, silentLogger,
      { scanPath: 'no-such-dir', dryRun: true, path: root })
    expect(out.result.filesProcessed).toBe(0)
    expect(out.result.dryRun).toBe(true)
  })

  it('refuses a real write unless the switch is on', async () => {
    await mkdir(path.join(root, 'specs'), { recursive: true })
    const s = makeServices()
    await expect(handleIndexSpecs(async () => s, silentLogger,
      { scanPath: 'specs', dryRun: false, path: root }))
      .rejects.toThrow(/CONTEXT_MILVUS_ADR_WRITE/)
  })

  it('scans only scanPath and never the whole repository', async () => {
    // Regression guard: an explicit scanPath sets planRoot to '', and "skip
    // plans" currently works only because scanDirectory('') fails and is
    // filtered out. If that ever starts returning the cwd instead, this test
    // is what stops a Codex tool from indexing a user's entire repo.
    await mkdir(path.join(root, 'specs'), { recursive: true })
    await mkdir(path.join(root, 'elsewhere'), { recursive: true })
    const design = (n: string) => `---\ntitle: ${n}\n---\n\n# ${n}\n\n引用 src/queue.ts 里的 push\n`
    await writeFile(path.join(root, 'specs', '2026-09-01-a-design.md'), design('a'), 'utf-8')
    await writeFile(path.join(root, 'elsewhere', '2026-09-02-b-design.md'), design('b'), 'utf-8')

    const s = makeServices()
    const out = await handleIndexSpecs(async () => s, silentLogger,
      { scanPath: 'specs', dryRun: true, path: root })

    expect(out.result.filesProcessed).toBe(1)
    const files = out.result.preview.map((p) => p.filePath)
    expect(files.every((f) => f.includes(`${path.sep}specs${path.sep}`))).toBe(true)
    expect(files.some((f) => f.includes('elsewhere'))).toBe(false)
  })
})
