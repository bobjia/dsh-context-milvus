/**
 * 会话根一致性回归测试。
 *
 * 背景：DSH 适配器里 ADR 的三个状态对象（AdrService / AdrAnchorIndex /
 * HashTracker）必须绑定到**同一个根**——当前会话的工作区。而 config.indexRoot
 * 的默认值是 process.cwd()（config.ts:257），即 DSH **服务进程**的 cwd，不是会话
 * 工作区。修复前只有 AdrService 跟着会话根，锚点索引与 tracker 仍固定在启动根。
 *
 * 后果（本机实测）：check_adr_consistency 读的是启动根 ~/docs/decisions 的锚点索引
 * （41 条，其中 36 条是另一个 Rust 仓库的 crates/...），却按会话根解析相对路径，
 * 于是报出 41 条失效锚点、100% 假阳性；本仓库自己的 9 条 ADR 从不出现。
 *
 * 本 spec 用两个锚点索引内容**不同**的临时根来钉住这一点：读到的必须永远是会话根
 * 那一份。两个根里还放了**同 id、不同正文**的 ADR，用来同时证明 AdrService 读的
 * 也是会话根（id 撞车在实测里真实存在：本仓库与 pipixia-rs 都有 ADR-0004）。
 */
import { jest } from '@jest/globals'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'

// Mock dsh-tools（与其它 dsh spec 一致；只取工具定义，不启动 Cordis）
const mockRegister = jest.fn(() => jest.fn())
const mockDefineTool = jest.fn((opts: any) => opts)
jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: mockDefineTool,
}))

// core barrel 会在 import 时加载 Milvus SDK，Jest 的 ESM 运行时无法加载它
// （uuid 是 ESM-only），必须先打桩。本 spec 不触发任何 Milvus 调用。
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const core = await import('dsh-context-milvus-core')
const { createAdrRuntimeResolver, resolveAdrRootForSession, workspaceRootForExec } =
  await import('../src/plugins/dsh-context-milvus/adr-runtime.js')
const { registerAdrTools } = await import('../src/plugins/dsh-context-milvus/adr-tools.js')

/** 一份最小但合法的 ADR 文档；正文用于区分两个根。 */
function adrDoc(id: string, summary: string): string {
  return `---
id: ${id}
type: decision-record
status: active
created: 2026-09-18
updated: 2026-09-18
author: test
code_anchors: []
related_decisions: []
auto_generated: false
---

## 决策目标

${summary}
`
}

/** 组装一个根（ADR 目录）对应的 startup runtime。 */
async function makeStartup(adrRoot: string) {
  const anchorIndex = new core.AdrAnchorIndex(core.deriveAnchorIndexPath(adrRoot))
  await anchorIndex.load().catch(() => {})
  const tracker = new core.HashTracker(core.deriveAdrTrackerPath(adrRoot))
  await tracker.load().catch(() => {})
  return {
    root: adrRoot,
    service: new core.AdrService(adrRoot, { createWhenMissing: true }),
    anchorIndex,
    tracker,
  }
}

/** 写入一份锚点索引（格式与 AdrAnchorIndex.save() 一致）。 */
async function writeAnchorIndex(adrRoot: string, fileToAdrs: Record<string, string[]>): Promise<void> {
  const adrToFiles: Record<string, string[]> = {}
  for (const [file, ids] of Object.entries(fileToAdrs)) {
    for (const id of ids) (adrToFiles[id] ??= []).push(file)
  }
  // 状态文件落在 $HOME/.milvus-index/ 下（deriveAnchorIndexPath），
  // 目录本身由调用方负责创建（AdrAnchorIndex.save() 不 mkdir，HashTracker.save() 才 mkdir）。
  const anchorPath = core.deriveAnchorIndexPath(adrRoot)
  await fs.mkdir(path.dirname(anchorPath), { recursive: true })
  await fs.writeFile(
    anchorPath,
    JSON.stringify({ fileToAdrs, adrToFiles }, null, 2),
    'utf-8',
  )
}

describe('ADR 会话根一致性', () => {
  // A = 启动根（config.indexRoot，等价于 DSH 服务进程 cwd）
  // B = 会话工作区（exec.agent.session.header.cwd）
  let rootA: string
  let rootB: string
  let adrRootA: string
  let adrRootB: string
  let config: any
  let ctx: any
  let milvus: any
  let mockRunAdrIndex: any
  // deriveMerkleFilePath 把状态文件放在 $HOME/.milvus-index/ 下：把 HOME 指到临时目录，
  // 测试才能自建锚点索引文件，也不会碰用户真实的状态文件。
  const realHome = process.env.HOME
  let fakeHome: string

  beforeAll(async () => {
    fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-session-home-'))
    process.env.HOME = fakeHome
  })

  afterAll(async () => {
    if (realHome === undefined) delete process.env.HOME
    else process.env.HOME = realHome
    await fs.rm(fakeHome, { recursive: true, force: true })
  })

  beforeEach(async () => {
    jest.clearAllMocks()
    rootA = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-session-a-'))
    rootB = await fs.mkdtemp(path.join(os.tmpdir(), 'adr-session-b-'))
    adrRootA = path.join(rootA, 'docs', 'decisions')
    adrRootB = path.join(rootB, 'docs', 'decisions')
    await fs.mkdir(adrRootA, { recursive: true })
    await fs.mkdir(adrRootB, { recursive: true })

    // A 根：无关仓库的锚点（对应实测里那 36 条 crates/...）。这些路径在 B 根下不存在。
    await writeAnchorIndex(adrRootA, { 'crates/only-in-a.rs': ['ADR-0004-shared-id'] })
    // B 根：会话工作区自己的锚点。
    await writeAnchorIndex(adrRootB, { 'src/only-in-b.ts': ['ADR-0004-shared-id'] })

    // B 根的锚点文件真实存在 → 读到 B 的索引就不该有任何失效锚点。
    await fs.mkdir(path.join(rootB, 'src'), { recursive: true })
    await fs.writeFile(path.join(rootB, 'src', 'only-in-b.ts'), 'export const b = 1\n', 'utf-8')

    // 两个根各有一份**同 id、不同正文**的 ADR：证明 service 读的也是会话根。
    await fs.writeFile(path.join(adrRootA, 'ADR-0004-shared-id.md'), adrDoc('ADR-0004-shared-id', 'A 根的决策'), 'utf-8')
    await fs.writeFile(path.join(adrRootB, 'ADR-0004-shared-id.md'), adrDoc('ADR-0004-shared-id', 'B 根的决策'), 'utf-8')

    config = { adrEnabled: true, indexRoot: rootA, adrRoot: 'docs/decisions' }
    ctx = { tools: { register: mockRegister } }
    milvus = {
      searchAdr: jest.fn().mockResolvedValue([]),
      ensureAdrCollection: jest.fn().mockResolvedValue(undefined),
    }
    mockRunAdrIndex = jest.fn().mockResolvedValue({ filesIndexed: 0, chunksIndexed: 0 })
  })

  afterEach(async () => {
    await fs.rm(rootA, { recursive: true, force: true })
    await fs.rm(rootB, { recursive: true, force: true })
  })

  /** 会话 exec：工作区 = B，而 config.indexRoot = A。 */
  function sessionExec() {
    return { agent: { session: { header: { cwd: rootB } } } }
  }

  function toolDef(name: string) {
    const def = mockRegister.mock.calls.find((c: any) => c[0].name === name)?.[0]
    expect(def).toBeDefined()
    return def
  }

  async function setup(adrIndexer?: any) {
    const startup = await makeStartup(adrRootA)
    const resolver = createAdrRuntimeResolver({ resolveConfig: () => config, startup })
    registerAdrTools(ctx, () => config, () => milvus, resolver, adrIndexer)
    return { startup, resolver }
  }

  // ── 验收标准 1：锚点索引跟随会话根 ──────────────────────────────────────

  it('check_adr_consistency 读会话根的锚点索引，而不是启动根的', async () => {
    await setup()
    const result = await toolDef('check_adr_consistency').execute({}, sessionExec())

    // 启动根 A 的锚点（crates/...）绝不能被读进来 —— 修复前 41/41 全是这类假阳性。
    expect(result.staleAnchors.map((a: any) => a.file)).not.toContain('crates/only-in-a.rs')
    // 会话根 B 的锚点文件存在 → 一条失效都不该有。
    expect(result.staleAnchors).toEqual([])
  })

  it('search_adr_by_file 用会话根的索引，并从会话根读 ADR 正文', async () => {
    await setup()
    const exec = sessionExec()

    const bHits = await toolDef('search_adr_by_file').execute({ file_path: 'src/only-in-b.ts' }, exec)
    expect(bHits).toHaveLength(1)
    expect(bHits[0].adrId).toBe('ADR-0004-shared-id')
    // 两个根 id 撞车、正文不同：读到的必须是 B 根那一份。
    expect(bHits[0].summary).toContain('B 根的决策')
    expect(bHits[0].summary).not.toContain('A 根的决策')

    // A 根的锚点在会话根下不存在 → 不该命中。
    const aHits = await toolDef('search_adr_by_file').execute({ file_path: 'crates/only-in-a.rs' }, exec)
    expect(aHits).toEqual([])
  })

  // ── 验收标准 3：sessionCwd 缺失时回落到 config 根（向后兼容） ────────────

  it('sessionCwd 缺失时回落到 config.indexRoot，行为与改动前一致', async () => {
    await setup()

    // 无会话上下文 → 工作区 = config.indexRoot = A，读 A 的索引。
    const result = await toolDef('check_adr_consistency').execute({}, {})
    expect(result.staleAnchors.map((a: any) => a.file)).toEqual(['crates/only-in-a.rs'])

    const hits = await toolDef('search_adr_by_file').execute({ file_path: 'crates/only-in-a.rs' }, {})
    expect(hits).toHaveLength(1)
    expect(hits[0].summary).toContain('A 根的决策')
  })

  // ── 验收标准 2（写入路径）：index/tracker/service 三者同根 ──────────────

  it('create_adr 写到会话根，并把会话根的 tracker/anchorIndex 交给 runAdrIndex', async () => {
    const { resolver } = await setup({ runAdrIndex: mockRunAdrIndex })
    const exec = sessionExec()
    const rtB = await resolver.forExec(exec)

    const result = await toolDef('create_adr').execute({ title: 'session root write' }, exec)

    // 新 ADR 落在会话根的 ADR 目录里，而不是 config 根。
    expect(result.filePath.startsWith(adrRootB + path.sep)).toBe(true)
    const bFiles = await fs.readdir(adrRootB)
    expect(bFiles.some(f => f.includes('session-root-write'))).toBe(true)
    const aFiles = await fs.readdir(adrRootA)
    expect(aFiles.some(f => f.includes('session-root-write'))).toBe(false)

    // runAdrIndex 必须拿到**会话根**的三个对象。
    expect(mockRunAdrIndex).toHaveBeenCalledTimes(1)
    const call = mockRunAdrIndex.mock.calls[0]
    expect(call[0].adrRoot).toBe(adrRootB)
    expect(call[2]).toBe(rtB.tracker)
    expect(call[3]).toBe(rtB.anchorIndex)
  })

  // ── forExec 缓存 / peek 语义 ────────────────────────────────────────────

  it('forExec 按 root 缓存：同一会话连续调用返回同一对象', async () => {
    const { startup, resolver } = await setup()
    const exec = sessionExec()

    const first = await resolver.forExec(exec)
    const second = await resolver.forExec(exec)
    expect(first).toBe(second)
    expect(first.root).toBe(adrRootB)
    expect(first).not.toBe(startup)

    // 根与会话一致时直接复用 startup（不再重复加载状态文件）。
    expect(await resolver.forExec({ agent: { session: { header: { cwd: rootA } } } })).toBe(startup)
  })

  it('peek 同步尽力而为：未命中返回 startup，命中返回缓存的会话 runtime', async () => {
    const { startup, resolver } = await setup()
    const exec = sessionExec()

    expect(resolver.peek(exec)).toBe(startup)   // 尚未加载
    const rt = await resolver.forExec(exec)     // 异步填缓存
    expect(resolver.peek(exec)).toBe(rt)
    expect(resolver.peek(exec)).not.toBe(startup)
    expect(resolver.peek(undefined)).toBe(startup)   // 无会话上下文 → startup
  })

  // ── 根解析工具函数 ──────────────────────────────────────────────────────

  it('workspaceRootForExec / resolveAdrRootForSession 的解析基准', () => {
    const exec = sessionExec()
    expect(workspaceRootForExec(() => config, exec)).toBe(rootB)
    expect(workspaceRootForExec(() => config, undefined)).toBe(rootA)
    // runtime.root 是 ADR 目录，锚点解析基准是工作区根 —— 两者必须成对出现。
    expect(resolveAdrRootForSession(config, rootB)).toBe(adrRootB)
    expect(resolveAdrRootForSession(config, undefined)).toBe(adrRootA)
    expect(resolveAdrRootForSession(config, rootB)).not.toBe(rootB)
  })
})
