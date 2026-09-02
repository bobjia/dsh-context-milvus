// test/adr-tools.spec.ts
import { jest } from '@jest/globals'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

// Mock dsh-tools
const mockRegister = jest.fn()
const mockDefineTool = jest.fn((opts: any) => opts)

jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: mockDefineTool,
}))

// Mock modules for registerTools (tools.ts)
// Note: jest.unstable_mockModule resolves relative paths from the test file,
// so we use paths relative to test/ that point to the source modules.
const mockRunAdrIndex = jest.fn()
const mockGetAdrIndexStatus = jest.fn()
jest.unstable_mockModule('../src/plugins/dsh-context-milvus/adr-indexer.js', () => ({
  runAdrIndex: mockRunAdrIndex,
  getAdrIndexStatus: mockGetAdrIndexStatus,
}))

const mockRunIndex = jest.fn()
const mockGetIndexStatus = jest.fn()
jest.unstable_mockModule('../src/plugins/dsh-context-milvus/indexer.js', () => ({
  runIndex: mockRunIndex,
  getIndexStatus: mockGetIndexStatus,
}))

class MockHashTracker {
  constructor(_path: string) {}
  async load() {}
  async save() {}
  computeDelta() { return { toIndex: [], toRemove: [], unchanged: [] } }
  getStats() { return { totalFiles: 0, totalChunks: 0 } }
  getLastIndexedTimestamp() { return null }
}
jest.unstable_mockModule('../src/plugins/dsh-context-milvus/merkle.js', () => ({
  HashTracker: MockHashTracker,
}))

const { registerAdrTools } = await import('../src/plugins/dsh-context-milvus/adr-tools.js')
const { registerTools } = await import('../src/plugins/dsh-context-milvus/tools.js')

describe('registerAdrTools', () => {
  let ctx: any
  let milvus: any
  let adrService: any
  let anchorIndex: any
  let resolveConfig: any

  beforeEach(() => {
    jest.clearAllMocks()
    ctx = { tools: { register: mockRegister } }
    milvus = {
      searchAdr: jest.fn().mockResolvedValue([]),
      ensureAdrCollection: jest.fn().mockResolvedValue(undefined),
    }
    adrService = {
      createAdr: jest.fn().mockResolvedValue({ id: 'ADR-0001-test', filePath: '/test.md' }),
      updateAdr: jest.fn().mockResolvedValue({ id: 'ADR-0001-test', filePath: '/test.md' }),
      listAdrs: jest.fn().mockResolvedValue([]),
      loadAdr: jest.fn().mockResolvedValue(null),
      getActiveConstraints: jest.fn().mockResolvedValue([]),
    }
    anchorIndex = {
      getAdrsForFile: jest.fn().mockReturnValue([]),
      getStats: jest.fn().mockReturnValue({ adrCount: 0, anchorCount: 0 }),
      getAll: jest.fn().mockReturnValue(new Map()),
    }
    resolveConfig = jest.fn().mockReturnValue({ adrEnabled: true })
  })

  it('registers 8 tools when adrEnabled is true', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    expect(mockRegister).toHaveBeenCalledTimes(8)
  })

  it('registers no tools when adrEnabled is false', () => {
    resolveConfig.mockReturnValue({ adrEnabled: false })
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('search_adr tool calls milvus.searchAdr', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const searchAdrDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr')?.[0]
    expect(searchAdrDef).toBeDefined()
    await searchAdrDef.execute({ query: 'test query', topK: 3 })
    expect(milvus.searchAdr).toHaveBeenCalledWith('test query', 3, undefined)
  })

  it('search_adr passes path prefix filter', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const searchAdrDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr')?.[0]
    await searchAdrDef.execute({ query: 'test', path: '/workspace/project', status: 'active' })
    expect(milvus.searchAdr).toHaveBeenCalledWith('test', 5, { status: 'active', pathPrefix: '/workspace/project' })
  })

  it('search_adr output schema includes docType', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const searchAdrDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr')?.[0]
    expect(searchAdrDef).toBeDefined()
    const props = searchAdrDef.output.schema.items.properties
    expect(props.docType).toEqual({ type: 'string' })
  })

  it('search_adr render includes docType label', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const searchAdrDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr')?.[0]
    expect(searchAdrDef).toBeDefined()

    // Test with spec docType
    const specResult = searchAdrDef.output.render({}, [{
      adrId: 'SPEC-1', status: 'active', docType: 'spec', section: '概述',
      filePath: '/a.md', score: 0.9, content: 'hello',
    }])
    expect(specResult[0].text).toContain('(active, spec)')

    // Test with plan docType
    const planResult = searchAdrDef.output.render({}, [{
      adrId: 'PLAN-1', status: 'active', docType: 'plan', section: '目标',
      filePath: '/b.md', score: 0.8, content: 'world',
    }])
    expect(planResult[0].text).toContain('(active, plan)')

    // Test without docType (e.g. regular ADR)
    const adrResult = searchAdrDef.output.render({}, [{
      adrId: 'ADR-0001', status: 'active', section: '背景',
      filePath: '/c.md', score: 0.7, content: 'test',
    }])
    // Should NOT contain ', spec' or ', plan'
    expect(adrResult[0].text).toContain('(active)')
    expect(adrResult[0].text).not.toContain(', spec')
    expect(adrResult[0].text).not.toContain(', plan')
  })

  it('search_adr_by_file calls anchorIndex.getAdrsForFile', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr_by_file')?.[0]
    expect(toolDef).toBeDefined()
    anchorIndex.getAdrsForFile.mockReturnValue(['ADR-0001'])
    adrService.loadAdr.mockResolvedValue({ frontmatter: { id: 'ADR-0001' }, sections: { '决策目标': 'test' } })
    await toolDef.execute({ file_path: 'src/test.ts' })
    expect(anchorIndex.getAdrsForFile).toHaveBeenCalledWith('src/test.ts')
  })

  it('create_adr calls adrService.createAdr', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'create_adr')?.[0]
    await toolDef.execute({ title: 'test' })
    expect(adrService.createAdr).toHaveBeenCalledWith({ title: 'test' })
  })

  it('update_adr calls adrService.updateAdr with mapped args', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'update_adr')?.[0]
    await toolDef.execute({
      adr_id: 'ADR-0001-test',
      content: 'new body',
      status: 'superseded',
      superseded_by: 'ADR-0002-x',
    })
    expect(adrService.updateAdr).toHaveBeenCalledWith('ADR-0001-test', {
      content: 'new body',
      status: 'superseded',
      supersededBy: 'ADR-0002-x',
    })
  })

  it('list_adrs calls adrService.listAdrs', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'list_adrs')?.[0]
    await toolDef.execute({ status: 'active' })
    expect(adrService.listAdrs).toHaveBeenCalledWith({ status: 'active', limit: 100 })
  })

  it('check_adr_consistency checks anchors', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'check_adr_consistency')?.[0]
    const result = await toolDef.execute({})
    expect(result).toHaveProperty('staleAnchors')
    expect(result).toHaveProperty('uncoveredChanges')
  })

  it('check_adr_consistency detects stale anchors for missing files', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'check_adr_consistency')?.[0]
    anchorIndex.getAll.mockReturnValue(new Map([
      ['/nonexistent/path/file.ts', ['ADR-0001', 'ADR-0002']],
    ]))
    const result = await toolDef.execute({})
    expect(result.staleAnchors).toHaveLength(1)
    expect(result.staleAnchors[0]).toEqual({
      adrId: 'ADR-0001, ADR-0002',
      file: '/nonexistent/path/file.ts',
      issue: '文件已不存在',
    })
    expect(result.uncoveredChanges).toHaveLength(0)
  })

  it('check_adr_consistency flags uncovered files', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'check_adr_consistency')?.[0]
    anchorIndex.getAll.mockReturnValue(new Map([
      ['/workspace/src/covered.ts', ['ADR-0001']],
    ]))
    const result = await toolDef.execute({ file_path: '/workspace/src/new-file.ts' })
    expect(result.staleAnchors).toHaveLength(0)
    expect(result.uncoveredChanges).toHaveLength(1)
    expect(result.uncoveredChanges[0]).toEqual({
      adrId: 'N/A',
      file: '/workspace/src/new-file.ts',
      status: 'uncovered',
    })
  })
})

describe('index_specs tool', () => {
  let ctx: any
  let milvus: any
  let adrService: any
  let anchorIndex: any
  let resolveConfig: any
  let tempDir: string
  let specsDir: string

  beforeEach(async () => {
    jest.clearAllMocks()
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'index-specs-test-'))
    specsDir = path.join(tempDir, 'specs')
    await fs.mkdir(specsDir, { recursive: true })
    await fs.mkdir(path.join(tempDir, 'src'), { recursive: true })

    // Create a code file that the anchor generator can find
    await fs.writeFile(path.join(tempDir, 'src', 'lib.ts'), 'export function foo() {}')

    // Create a spec file without frontmatter
    await fs.writeFile(path.join(specsDir, '2026-09-02-my-design.md'),
      '# My Design\n\n@file:src/lib.ts\n\nThis is a design document.\n')

    ctx = { tools: { register: mockRegister } }
    milvus = {
      searchAdr: jest.fn().mockResolvedValue([]),
      ensureAdrCollection: jest.fn().mockResolvedValue(undefined),
    }
    adrService = {
      createAdr: jest.fn().mockResolvedValue({ id: 'ADR-0001-test', filePath: '/test.md' }),
      updateAdr: jest.fn().mockResolvedValue({ id: 'ADR-0001-test', filePath: '/test.md' }),
      listAdrs: jest.fn().mockResolvedValue([]),
      loadAdr: jest.fn().mockResolvedValue(null),
      getActiveConstraints: jest.fn().mockResolvedValue([]),
    }
    anchorIndex = {
      getAdrsForFile: jest.fn().mockReturnValue([]),
      getStats: jest.fn().mockReturnValue({ adrCount: 0, anchorCount: 0 }),
      getAll: jest.fn().mockReturnValue(new Map()),
    }
    resolveConfig = jest.fn().mockReturnValue({ adrEnabled: true, indexRoot: tempDir })
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true })
  })

  it('registers index_specs tool', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]
    expect(toolDef).toBeDefined()
    expect(toolDef.name).toBe('index_specs')
    expect(toolDef.parameters).toHaveProperty('dry_run')
    expect(toolDef.parameters).toHaveProperty('path')
  })

  it('dry_run returns preview without modifying files', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]

    const result = await toolDef.execute({ path: specsDir, dry_run: true })

    expect(result.filesProcessed).toBe(1)
    expect(result.anchorsGenerated).toBeGreaterThanOrEqual(1)
    expect(result.dryRun).toBe(true)
    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)
    expect(result.preview).toHaveLength(1)
    expect(result.preview[0].filePath).toBe(path.join(specsDir, '2026-09-02-my-design.md'))
    expect(result.preview[0].adrId).toMatch(/^SPEC-/)
    expect(result.preview[0].detectedRefs).toHaveLength(1)
    expect(result.preview[0].detectedRefs[0].file).toContain('src/lib.ts')

    // Verify file was NOT modified (no frontmatter)
    const content = await fs.readFile(path.join(specsDir, '2026-09-02-my-design.md'), 'utf-8')
    expect(content.startsWith('---')).toBe(false)
  })

  it('writes frontmatter and indexes when not dry_run', async () => {
    const mockRunAdrIndex = jest.fn().mockResolvedValue({ filesIndexed: 1, chunksIndexed: 3 })
    const adrIndexer = { runAdrIndex: mockRunAdrIndex, tracker: {} }

    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex, adrIndexer)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]

    const result = await toolDef.execute({ path: specsDir, dry_run: false })

    expect(result.filesProcessed).toBe(1)
    expect(result.anchorsGenerated).toBeGreaterThanOrEqual(1)
    expect(result.dryRun).toBe(false)
    expect(result.filesIndexed).toBe(1)
    expect(result.chunksIndexed).toBe(3)

    // Verify file WAS modified (has frontmatter)
    const content = await fs.readFile(path.join(specsDir, '2026-09-02-my-design.md'), 'utf-8')
    expect(content.startsWith('---')).toBe(true)
    expect(content).toContain('id: SPEC-')

    // Verify runAdrIndex was called
    expect(mockRunAdrIndex).toHaveBeenCalledTimes(1)
    const callArgs = mockRunAdrIndex.mock.calls[0]
    expect(callArgs[0].specRoot).toBe(specsDir)
    expect(callArgs[0].planRoot).toBe('')
    expect(callArgs[4]).toEqual({ mode: 'incremental' })
  })

  it('skips indexing when adrIndexer is not provided', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]

    const result = await toolDef.execute({ path: specsDir, dry_run: false })

    expect(result.filesProcessed).toBe(1)
    expect(result.anchorsGenerated).toBeGreaterThanOrEqual(1)
    expect(result.dryRun).toBe(false)
    // Without adrIndexer, indexing is skipped
    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)

    // File should still be written with frontmatter
    const content = await fs.readFile(path.join(specsDir, '2026-09-02-my-design.md'), 'utf-8')
    expect(content.startsWith('---')).toBe(true)
  })

  it('handles empty directories gracefully', async () => {
    const emptyDir = path.join(tempDir, 'empty')
    await fs.mkdir(emptyDir, { recursive: true })

    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]

    const result = await toolDef.execute({ path: emptyDir, dry_run: true })

    expect(result.filesProcessed).toBe(0)
    expect(result.anchorsGenerated).toBe(0)
    expect(result.dryRun).toBe(true)
    expect(result.preview).toHaveLength(0)
  })

  it('render formats dry_run output correctly', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]

    const result = toolDef.output.render({}, {
      filesProcessed: 2,
      anchorsGenerated: 5,
      filesIndexed: 0,
      chunksIndexed: 0,
      dryRun: true,
      preview: [
        { filePath: '/specs/a.md', adrId: 'SPEC-1', detectedRefs: [] },
        { filePath: '/specs/b.md', adrId: 'SPEC-2', detectedRefs: [{ file: '/src/lib.ts', symbols: ['foo'] }] },
      ],
    })

    expect(result[0].text).toContain('文件处理: 2')
    expect(result[0].text).toContain('锚点生成: 5')
    expect(result[0].text).toContain('模式: 预览')
    expect(result[0].text).toContain('SPEC-1')
    expect(result[0].text).toContain('SPEC-2')
    expect(result[0].text).toContain('foo')
  })

  it('render formats non-dry_run output correctly', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_specs')?.[0]

    const result = toolDef.output.render({}, {
      filesProcessed: 1,
      anchorsGenerated: 3,
      filesIndexed: 1,
      chunksIndexed: 4,
      dryRun: false,
      preview: [],
    })

    expect(result[0].text).toContain('文件处理: 1')
    expect(result[0].text).toContain('锚点生成: 3')
    expect(result[0].text).toContain('文件索引: 1')
    expect(result[0].text).toContain('分块索引: 4')
    expect(result[0].text).not.toContain('预览')
  })
})

describe('registerTools - index_code adr config', () => {
  let ctx: any
  let milvus: any
  let tracker: any
  let adrOptions: any
  let resolveConfig: any

  beforeEach(() => {
    jest.clearAllMocks()
    mockRunIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0, filesSkipped: 0, durationMs: 10,
    })
    mockRunAdrIndex.mockResolvedValue({
      filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0, filesSkipped: 0, durationMs: 5,
    })
    ctx = { tools: { register: mockRegister } }
    milvus = {
      ensureCollection: jest.fn().mockResolvedValue(undefined),
      ensureAdrCollection: jest.fn().mockResolvedValue(undefined),
      search: jest.fn().mockResolvedValue([]),
    }
    tracker = new MockHashTracker('/tmp/test')
    adrOptions = {
      service: { getActiveConstraints: jest.fn().mockResolvedValue([]) },
      anchorIndex: { getAdrsForFile: jest.fn().mockReturnValue([]) },
      adrTracker: new MockHashTracker('/tmp/test-adr'),
    }
    resolveConfig = jest.fn().mockReturnValue({
      adrEnabled: true,
      indexRoot: '/workspace/test',
      adrRoot: 'docs/decisions',
      specRoot: 'docs/superpowers/specs',
      planRoot: 'docs/superpowers/plans',
    })
  })

  it('passes absolute specRoot and planRoot to runAdrIndex', async () => {
    registerTools(ctx, resolveConfig, milvus, tracker, adrOptions)
    const indexCodeDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_code')?.[0]
    expect(indexCodeDef).toBeDefined()

    await indexCodeDef.execute({ mode: 'incremental' })

    expect(mockRunAdrIndex).toHaveBeenCalledTimes(1)
    const adrConfig = mockRunAdrIndex.mock.calls[0][0]
    expect(adrConfig.specRoot).toBe('/workspace/test/docs/superpowers/specs')
    expect(adrConfig.planRoot).toBe('/workspace/test/docs/superpowers/plans')
    expect(adrConfig.adrRoot).toBe('/workspace/test/docs/decisions')
  })

  it('does not call runAdrIndex when adrEnabled is false', async () => {
    resolveConfig.mockReturnValue({
      adrEnabled: false,
      indexRoot: '/workspace/test',
      adrRoot: 'docs/decisions',
      specRoot: 'docs/superpowers/specs',
      planRoot: 'docs/superpowers/plans',
    })
    registerTools(ctx, resolveConfig, milvus, tracker, adrOptions)
    const indexCodeDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_code')?.[0]
    expect(indexCodeDef).toBeDefined()

    await indexCodeDef.execute({ mode: 'incremental' })

    expect(mockRunAdrIndex).not.toHaveBeenCalled()
  })

  it('does not call runAdrIndex when adrOptions is not provided', async () => {
    registerTools(ctx, resolveConfig, milvus, tracker, undefined)
    const indexCodeDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'index_code')?.[0]
    expect(indexCodeDef).toBeDefined()

    await indexCodeDef.execute({ mode: 'incremental' })

    expect(mockRunAdrIndex).not.toHaveBeenCalled()
  })
})