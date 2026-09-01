// test/adr-tools.spec.ts
import { jest } from '@jest/globals'

// Mock dsh-tools
const mockRegister = jest.fn()
const mockDefineTool = jest.fn((opts: any) => opts)

jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: mockDefineTool,
}))

const { registerAdrTools } = await import('../src/plugins/dsh-context-milvus/adr-tools.js')

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

  it('registers 7 tools when adrEnabled is true', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    expect(mockRegister).toHaveBeenCalledTimes(7)
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
})