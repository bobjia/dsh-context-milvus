/**
 * Regression test: settings edits must reach the running services.
 *
 * Everything the plugin derives from config at load time has to be refreshed
 * when the matching setting changes — otherwise the config panel shows the new
 * value while the tools keep using the old one until a plugin reload. This spec
 * covers both classes of derived state:
 *
 *   - constructed services: Milvus client + embedding client
 *   - startup-derived state: Merkle tracker, cross-file import map, ADR bundle
 *     (service + anchor index + hash tracker) and the ADR system prompt section
 *
 * The plugin's real apply() runs against a fake Cordis context; only the Milvus
 * SDK, HashTracker and ImportResolver are mocked so that each construction is
 * observable. The Milvus mock records the address of every client constructed,
 * which is ground truth for "which server does the plugin talk to".
 */

import { jest } from '@jest/globals'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const clientAddresses: string[] = []
const trackerPaths: string[] = []
const importMapPaths: string[] = []
const promptSections: any[] = []

// The real @deepseek-ai/dsh-tools cannot load here (its transitive
// @deepseek-ai/dsh-scope is not installed in this workspace). This test does
// not exercise tool-argument validation, so a pass-through stub is enough.
jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: any) => ({ ...options, execute: options.execute }),
}))

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => {
  class MilvusClient {
    connectPromise: Promise<void> = Promise.resolve()
    hasCollection = jest.fn(async () => ({ value: false }))
    describeCollection = jest.fn(async () => ({ schema: { fields: [] } }))
    createCollection = jest.fn(async () => ({}))
    createIndex = jest.fn(async () => ({}))
    loadCollectionSync = jest.fn(async () => ({}))
    insert = jest.fn(async () => ({ insert_cnt: 0 }))
    delete = jest.fn(async () => ({ delete_cnt: 0 }))
    search = jest.fn(async () => ({ results: [] }))
    hybridSearch = jest.fn(async () => ({ results: [] }))
    query = jest.fn(async () => ({ data: [] }))
    constructor(opts: any) {
      clientAddresses.push(opts.address)
      // A client built for this address fails its connection handshake late —
      // it models the startup instance whose error only lands after a settings
      // edit has already superseded it.
      if (opts.address === 'fail-lazy:19530') {
        this.connectPromise = new Promise((_resolve, reject) =>
          setTimeout(() => reject(new Error('connect ECONNREFUSED fail-lazy:19530')), 80),
        )
      }
    }
  }
  return {
    MilvusClient,
    DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
    MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
    FunctionType: { BM25: 'BM25' },
    RANKER_TYPE: { RRF: 'rrf' },
    ErrorCode: { SUCCESS: 'Success' },
  }
})

jest.unstable_mockModule('../../core/src/merkle.js', () => ({
  HashTracker: class {
    constructor(p: string) { trackerPaths.push(p) }
    async load() {}
    async save() {}
    computeDelta() { return { toIndex: [], toRemove: [], unchanged: [] } }
    getStats() { return { totalFiles: 0, totalChunks: 0 } }
    getLastIndexedTimestamp() { return null }
    removeRecords() {}
  },
}))

jest.unstable_mockModule('../../core/src/import-resolver.js', () => ({
  ImportResolver: class {
    constructor(p: string) { importMapPaths.push(p) }
    async load() {}
    isLoaded() { return true }
    resolve() { return null }
    getExports() { return [] }
  },
}))

const { getConfig, deriveImportMapFilePath } = await import('dsh-context-milvus-core')
const { deriveAdrTrackerPath } = await import('../../core/src/config.js')
const plugin = await import('../src/plugins/dsh-context-milvus/index.js')

/** Poll until `cond` holds — settings changes are applied through a promise chain. */
async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now()
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('waitFor: condition not met in time')
    await new Promise((r) => setTimeout(r, 5))
  }
}

/** Boot the plugin against a fake context whose settings section can be edited. */
async function createHarness(entry: Record<string, unknown>) {
  clientAddresses.length = 0
  trackerPaths.length = 0
  importMapPaths.length = 0
  promptSections.length = 0

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-hot-reload-'))
  const state = { value: { indexRoot: tmp, adrEnabled: false, ...entry } as Record<string, unknown> }
  const tools: any[] = []
  let volatileHandler: (() => void) | null = null

  // dsh-settings ≥0.1.7 hands `apply()` the entry's reactive config: every field
  // is a volatile accessor, so reading the section means calling .get() per key
  // (that is exactly what the plugin's readOverrides() unwraps). The accessors
  // close over `state`, so a commit is visible without rebuilding the object.
  const reactiveConfig = new Proxy({} as Record<string, unknown>, {
    ownKeys: () => Reflect.ownKeys(state.value),
    getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
    get: (_target, key: string) => ({ get: () => state.value[key] }),
  })

  const ctx: any = {
    tools: {
      register: (def: any) => {
        tools.push(def)
        return () => {
          const i = tools.indexOf(def)
          if (i >= 0) tools.splice(i, 1)
        }
      },
    },
    // Fake systemPrompt service, so ADR prompt registration is observable.
    get: (name: string) =>
      name === 'systemPrompt'
        ? {
            section: (s: any) => { promptSections.push(s); return () => {} },
            context: () => () => {},
          }
        : undefined,
    // The loader announces a committed GUI edit on this event; the plugin
    // subscribes to it in place of installSection's onChange callback.
    on: (event: string, cb: () => void) => {
      if (event === 'loader/volatile-update') volatileHandler = cb
      return () => {}
    },
    effect: () => () => {},
    logger: () => {},
  }

  await plugin.apply(ctx, reactiveConfig)
  await new Promise((r) => setTimeout(r, 20)) // let fire-and-forget ensureCollection settle

  return {
    tmp,
    tools,
    addresses: clientAddresses,
    trackerPaths,
    importMapPaths,
    promptSections,
    /** Commit a settings-layer patch and notify the plugin, as the GUI does. */
    commit: (patch: Record<string, unknown>) => {
      state.value = { ...state.value, ...patch }
      if (!volatileHandler) throw new Error('plugin never subscribed to loader/volatile-update')
      volatileHandler()
    },
    config: () => getConfig(plugin.readOverrides(reactiveConfig)),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  }
}

/** Stub the embedding endpoint so search_code never touches the network. */
function stubEmbedding(): void {
  ;(globalThis as any).fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ embeddings: [[0.1, 0.2]] }),
  })
}

async function runSearch(h: { tools: any[]; tmp: string }): Promise<void> {
  const searchTool = h.tools.find((t) => t.name === 'search_code')
  expect(searchTool).toBeDefined()
  await searchTool.execute(
    { query: 'anything', topK: 1 },
    { agent: { session: { header: { cwd: h.tmp } } } },
  )
}

describe('settings hot-reload', () => {
  it('rebuilds the Milvus client when milvusAddress changes', async () => {
    const h = await createHarness({ milvusAddress: 'old-host:19530' })
    try {
      stubEmbedding()
      expect(h.addresses).toEqual(['old-host:19530'])

      h.commit({ milvusAddress: 'new-host:19530' })
      expect(h.config().milvusAddress).toBe('new-host:19530')
      await waitFor(() => h.addresses.length === 2)

      await runSearch(h)

      expect(h.addresses).toEqual(['old-host:19530', 'new-host:19530'])
    } finally {
      h.cleanup()
    }
  })

  it('stays silent when the startup Milvus client fails after a settings rebuild superseded it', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await createHarness({ milvusAddress: 'fail-lazy:19530' })
    try {
      // A settings rebuild (the GUI value arriving right after boot) replaces
      // the startup client before its 80ms-late connection error lands.
      h.commit({ milvusAddress: 'new-host:19530' })
      await waitFor(() => h.addresses.length === 2)
      // Outlive the lazy failure, a microtask flush, and the rebuild's own
      // fire-and-forget ensureCollection.
      await new Promise((r) => setTimeout(r, 150))

      expect(warnSpy.mock.calls.map((c) => String(c[0]))).not.toContainEqual(
        expect.stringContaining('集合初始化失败'),
      )
    } finally {
      h.cleanup()
      warnSpy.mockRestore()
    }
  })

  it('warns when the current Milvus client fails to initialize', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const h = await createHarness({ milvusAddress: 'fail-lazy:19530' })
    try {
      // No rebuild — the lazy failure belongs to the live client and must
      // still surface so a genuinely unreachable Milvus is not swallowed.
      await new Promise((r) => setTimeout(r, 150))

      expect(warnSpy.mock.calls.map((c) => String(c[0]))).toContainEqual(
        expect.stringContaining('集合初始化失败'),
      )
    } finally {
      h.cleanup()
      warnSpy.mockRestore()
    }
  })

  it('does not rebuild anything when an unrelated setting changes', async () => {
    const h = await createHarness({ milvusAddress: 'old-host:19530' })
    try {
      stubEmbedding()
      const trackersBefore = [...h.trackerPaths]
      const importMapsBefore = [...h.importMapPaths]

      h.commit({ telemetryEnabled: true })
      await new Promise((r) => setTimeout(r, 150))

      expect(h.addresses).toEqual(['old-host:19530'])
      expect(h.trackerPaths).toEqual(trackersBefore)
      expect(h.importMapPaths).toEqual(importMapsBefore)
    } finally {
      h.cleanup()
    }
  })

  it('rebuilds the default Merkle tracker when merkleFilePath changes', async () => {
    const h = await createHarness({
      merkleFilePath: path.join(os.tmpdir(), 'dsh-hot-reload-startup-merkle.json'),
    })
    try {
      expect(h.trackerPaths).toContain(path.join(os.tmpdir(), 'dsh-hot-reload-startup-merkle.json'))

      const next = path.join(os.tmpdir(), 'dsh-hot-reload-next-merkle.json')
      h.commit({ merkleFilePath: next })

      await waitFor(() => h.trackerPaths.includes(next))
    } finally {
      h.cleanup()
    }
  })

  it('rebuilds the import resolver when indexRoot changes', async () => {
    const h = await createHarness({})
    try {
      const rootA = path.join(h.tmp, 'ws-a')
      const rootB = path.join(h.tmp, 'ws-b')
      h.commit({ indexRoot: rootA })
      await waitFor(() => h.importMapPaths.includes(deriveImportMapFilePath(rootA)))

      h.commit({ indexRoot: rootB })
      await waitFor(() => h.importMapPaths.includes(deriveImportMapFilePath(rootB)))
    } finally {
      h.cleanup()
    }
  })

  it('rebuilds the ADR state files when adrRoot changes', async () => {
    const h = await createHarness({ adrEnabled: true, adrRoot: 'docs/decisions' })
    try {
      const startupRoot = path.resolve(h.tmp, 'docs/decisions')
      expect(h.trackerPaths).toContain(deriveAdrTrackerPath(startupRoot))

      h.commit({ adrRoot: 'docs/other-decisions' })

      const nextRoot = path.resolve(h.tmp, 'docs/other-decisions')
      await waitFor(() => h.trackerPaths.includes(deriveAdrTrackerPath(nextRoot)))
      // ADR tools stay registered across the rebuild.
      expect(h.tools.map((t) => t.name)).toContain('search_adr')
    } finally {
      h.cleanup()
    }
  })

  it('refreshes the ADR system prompt section when adrSystemPrompt changes', async () => {
    const h = await createHarness({ adrEnabled: true })
    try {
      // Boot also registers the code-search:rules section (SPEC-2026-09-24-onboarding-activation
      // fix C), so scope this to the ADR section rather than counting every prompt section.
      expect(h.promptSections.filter((s) => s.name === 'decision-memory:rules').length).toBe(1)

      h.commit({ adrSystemPrompt: 'CUSTOM-PROMPT-MARKER' })

      await waitFor(() => h.promptSections.some((s) => s.text === 'CUSTOM-PROMPT-MARKER'))
    } finally {
      h.cleanup()
    }
  })

  it('registers the code-search prompt section on boot (fix C)', async () => {
    const h = await createHarness({})
    try {
      const section = h.promptSections.find((s) => s.name === 'code-search:rules')
      expect(section).toBeDefined()
      expect(section.order).toBe(1480)
      expect(section.text).toContain('search_code')
    } finally {
      h.cleanup()
    }
  })

  it('registers ADR tools when adrEnabled is turned on, and unregisters on off', async () => {
    const h = await createHarness({ milvusAddress: 'old-host:19530', adrEnabled: false })
    try {
      expect(h.tools.map((t) => t.name)).not.toContain('search_adr')

      h.commit({ adrEnabled: true })
      await waitFor(() => h.tools.map((t) => t.name).includes('search_adr'))

      h.commit({ adrEnabled: false })
      await waitFor(() => !h.tools.map((t) => t.name).includes('search_adr'))
    } finally {
      h.cleanup()
    }
  })

  it('registers ADR tools at startup when adrEnabled is already true', async () => {
    const h = await createHarness({ milvusAddress: 'old-host:19530', adrEnabled: true })
    try {
      expect(h.tools.map((t) => t.name)).toContain('search_adr')
    } finally {
      h.cleanup()
    }
  })
})
