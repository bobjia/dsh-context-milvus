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
    connectPromise = Promise.resolve()
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
  const state = { value: { indexRoot: tmp, adrEnabled: false, ...entry } as any }
  const tools: any[] = []
  let hooks: any = null

  const ctx: any = {
    inject: (_deps: string[], cb: any) =>
      cb({
        settings: {
          installSection: (_owner: any, _ns: string, _schema: any, _entry: any, h: any) => {
            hooks = h
            // Mirrors dsh-settings: the source thunk is installed, then
            // onChange() fires once for the attach itself.
            h.setSource(() => state.value)
            h.onChange()
          },
        },
      }),
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
    on: () => () => {},
    effect: () => () => {},
    logger: () => {},
  }

  await plugin.apply(ctx, state.value)
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
      hooks.onChange()
    },
    config: () => getConfig(state.value),
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
      expect(h.promptSections.length).toBe(1)

      h.commit({ adrSystemPrompt: 'CUSTOM-PROMPT-MARKER' })

      await waitFor(() => h.promptSections.some((s) => s.text === 'CUSTOM-PROMPT-MARKER'))
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
