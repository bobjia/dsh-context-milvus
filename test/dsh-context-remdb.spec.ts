/**
 * dsh-context-remdb tests
 *
 * Covers: config, merkle, chunker, embedding, remdb-service, and formatting helpers.
 * Uses jest.unstable_mockModule for ESM compatibility.
 */

import { jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync, mkdirSync } from 'node:fs'

// ═════════════════════════════════════════════════════════════════════════
// Mock remdb-sdk-node
// ═════════════════════════════════════════════════════════════════════════

const mockHasCollection = jest.fn()
const mockCreateCollection = jest.fn()
const mockInsert = jest.fn()
const mockDelete = jest.fn()
const mockSearch = jest.fn()

jest.unstable_mockModule('remdb-sdk-node', () => ({
  RemDbClient: jest.fn(() => ({
    hasCollection: mockHasCollection,
    createCollection: mockCreateCollection,
    insert: mockInsert,
    delete: mockDelete,
    search: mockSearch,
  })),
}))

// Helper to create a mock EmbeddingClient
function mockEmbeddingClient(vectors: number[][] = [[0.1, 0.2, 0.3]]): any {
  return { embed: jest.fn().mockResolvedValue(vectors) }
}

// Dynamic imports after mocking
const { getConfig } = await import('../src/plugins/dsh-context-remdb/config.js')
const { HashTracker } = await import('../src/plugins/dsh-context-remdb/merkle.js')
const { RemDbService } = await import('../src/plugins/dsh-context-remdb/remdb-service.js')
const { EmbeddingClient } = await import('../src/plugins/dsh-context-remdb/embedding.js')
const { runIndex, getIndexStatus } = await import('../src/plugins/dsh-context-remdb/indexer.js')

// ═════════════════════════════════════════════════════════════════════════
// getConfig
// ═════════════════════════════════════════════════════════════════════════

describe('getConfig()', () => {
  const OLD_ENV = process.env

  beforeEach(() => {
    jest.resetModules()
    process.env = { ...OLD_ENV }
    delete process.env.REMDB_ENDPOINT
    delete process.env.REMDB_TOKEN
    delete process.env.REMDB_COLLECTION
    delete process.env.REMDB_EMBEDDING_DIM
    delete process.env.INDEX_ROOT
    delete process.env.INDEX_EXTENSIONS
    delete process.env.HYBRID_MODE
  })

  afterAll(() => {
    process.env = OLD_ENV
  })

  it('returns default values when no env vars are set', () => {
    const config = getConfig()
    expect(config.remdbEndpoint).toBe('http://localhost:19530')
    expect(config.remdbToken).toBeUndefined()
    expect(config.remdbCollection).toBe('code_embeddings')
    expect(config.remdbDim).toBe(768)
    expect(config.hybridMode).toBe(true)
    expect(config.indexExtensions.length).toBeGreaterThan(0)
  })

  it('reads values from environment variables', () => {
    process.env.REMDB_ENDPOINT = 'http://custom:19530'
    process.env.REMDB_TOKEN = 'my-token'
    process.env.REMDB_COLLECTION = 'my_codes'
    process.env.REMDB_EMBEDDING_DIM = '1024'
    process.env.HYBRID_MODE = 'false'

    const config = getConfig()
    expect(config.remdbEndpoint).toBe('http://custom:19530')
    expect(config.remdbToken).toBe('my-token')
    expect(config.remdbCollection).toBe('my_codes')
    expect(config.remdbDim).toBe(1024)
    expect(config.hybridMode).toBe(false)
  })

  it('uses INDEX_EXTENSIONS for custom file types', () => {
    process.env.INDEX_EXTENSIONS = '.vue,.svelte,.astro'
    const config = getConfig()
    expect(config.indexExtensions).toEqual(['.vue', '.svelte', '.astro'])
  })

  it('Cordis config overrides environment variables', () => {
    process.env.REMDB_ENDPOINT = 'http://env:19530'
    process.env.REMDB_COLLECTION = 'env_collection'

    const config = getConfig({
      remdbEndpoint: 'http://config:19530',
      remdbCollection: 'config_collection',
    })

    expect(config.remdbEndpoint).toBe('http://config:19530')
    expect(config.remdbCollection).toBe('config_collection')
  })

  it('merges partial Cordis config with env var defaults', () => {
    process.env.REMDB_ENDPOINT = 'http://env:19530'

    const config = getConfig({
      remdbCollection: 'custom_collection',
    })

    expect(config.remdbEndpoint).toBe('http://env:19530') // from env
    expect(config.remdbCollection).toBe('custom_collection') // from config
  })
})

// ═════════════════════════════════════════════════════════════════════════
// HashTracker (Merkle)
// ═════════════════════════════════════════════════════════════════════════

describe('HashTracker', () => {
  let tempDir: string
  let tracker: HashTracker

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'remdb-test-'))
    tracker = new HashTracker(path.join(tempDir, 'merkle.json'))
  })

  afterEach(async () => {
    // Cleanup handled by OS temp dir
  })

  it('starts with empty state', async () => {
    const loaded = await tracker.load()
    expect(loaded).toBe(false)
    expect(tracker.getStats()).toEqual({ totalFiles: 0, totalChunks: 0 })
  })

  it('computes delta for new files', () => {
    const files = new Map([
      ['/src/a.ts', 'hash-a'],
      ['/src/b.ts', 'hash-b'],
    ])
    const delta = tracker.computeDelta(files)
    expect(delta.toIndex).toEqual(['/src/a.ts', '/src/b.ts'])
    expect(delta.toRemove).toEqual([])
    expect(delta.unchanged).toEqual([])
  })

  it('detects modified files', async () => {
    // First index
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)
    await tracker.save()

    // Reload
    const tracker2 = new HashTracker(path.join(tempDir, 'merkle.json'))
    await tracker2.load()

    // b.ts changed
    const files = new Map([
      ['/src/a.ts', 'hash-a'],
      ['/src/b.ts', 'hash-b-modified'],
    ])
    const delta = tracker2.computeDelta(files)
    expect(delta.toIndex).toEqual(['/src/b.ts'])
    expect(delta.toRemove).toEqual([])
    expect(delta.unchanged).toEqual(['/src/a.ts'])
  })

  it('detects deleted files', () => {
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)

    const files = new Map([['/src/a.ts', 'hash-a']])
    const delta = tracker.computeDelta(files)
    expect(delta.toIndex).toEqual([])
    expect(delta.toRemove).toEqual(['/src/b.ts'])
    expect(delta.unchanged).toEqual(['/src/a.ts'])
  })

  it('persists and reloads state', async () => {
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)
    await tracker.save()

    const tracker2 = new HashTracker(path.join(tempDir, 'merkle.json'))
    const loaded = await tracker2.load()
    expect(loaded).toBe(true)
    expect(tracker2.getStats()).toEqual({ totalFiles: 2, totalChunks: 5 })
  })

  it('removes specific records', () => {
    tracker.updateRecord('/src/a.ts', 'hash-a', 3)
    tracker.updateRecord('/src/b.ts', 'hash-b', 2)
    tracker.removeRecords(['/src/a.ts'])
    expect(tracker.getStats()).toEqual({ totalFiles: 1, totalChunks: 2 })
  })

  it('computes hash of content', () => {
    const hash1 = HashTracker.hashContent('hello world')
    const hash2 = HashTracker.hashContent('hello world')
    const hash3 = HashTracker.hashContent('hello world!')
    expect(hash1).toBe(hash2)
    expect(hash1).not.toBe(hash3)
    expect(hash1.length).toBe(64) // SHA-256 hex
  })
})

// ═════════════════════════════════════════════════════════════════════════
// EmbeddingClient
// ═════════════════════════════════════════════════════════════════════════

describe('EmbeddingClient', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns embeddings from OpenAI-compatible API', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        data: [
          { embedding: [0.1, 0.2, 0.3] },
          { embedding: [0.4, 0.5, 0.6] },
        ],
      }),
    })

    const client = new EmbeddingClient({
      endpoint: 'http://localhost:19530/v2/vectordb/embedding',
      model: 'default',
      dim: 768,
    })

    const vectors = await client.embed(['hello', 'world'])
    expect(vectors).toHaveLength(2)
    expect(vectors[0]).toEqual([0.1, 0.2, 0.3])
    expect(vectors[1]).toEqual([0.4, 0.5, 0.6])
  })

  it('returns empty array for empty input', async () => {
    const client = new EmbeddingClient({
      endpoint: 'http://localhost:19530/v2/vectordb/embedding',
      model: 'default',
      dim: 768,
    })
    const vectors = await client.embed([])
    expect(vectors).toEqual([])
  })

  it('throws on API error', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: () => Promise.resolve('invalid api key'),
    })

    const client = new EmbeddingClient({
      endpoint: 'http://localhost:19530/v2/vectordb/embedding',
      model: 'default',
      dim: 768,
    })

    await expect(client.embed(['test'])).rejects.toThrow('Embedding API error')
  })
})

// ═════════════════════════════════════════════════════════════════════════
// RemDbService
// ═════════════════════════════════════════════════════════════════════════

describe('RemDbService', () => {
  const defaultConfig = {
    endpoint: 'http://localhost:19530',
    token: undefined as string | undefined,
    collection: 'test_collection',
    dim: 768,
    embeddingClient: mockEmbeddingClient(),
  }

  beforeEach(() => {
    mockHasCollection.mockReset()
    mockCreateCollection.mockReset()
    mockInsert.mockReset()
    mockDelete.mockReset()
    mockSearch.mockReset()
  })

  describe('ensureCollection()', () => {
    it('does nothing when the collection already exists', async () => {
      mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })

      const service = new RemDbService(defaultConfig)
      await service.ensureCollection()

      expect(mockHasCollection).toHaveBeenCalledWith({ collectionName: 'test_collection' })
      expect(mockCreateCollection).not.toHaveBeenCalled()
    })

    it('creates collection when it does not exist', async () => {
      mockHasCollection.mockResolvedValue({ code: 0, data: { has: false } })
      mockCreateCollection.mockResolvedValue({ code: 0 })

      const service = new RemDbService(defaultConfig)
      await service.ensureCollection()

      expect(mockCreateCollection).toHaveBeenCalledTimes(1)
      const callArgs = (mockCreateCollection.mock.calls[0] as any[])[0] as any
      expect(callArgs.collectionName).toBe('test_collection')
      expect(callArgs.indexParams[0].metricType).toBe('COSINE')
    })
  })

  describe('search()', () => {
    it('returns formatted results', async () => {
      mockSearch.mockResolvedValue({
        code: 0,
        data: [
          {
            id: 1,
            distance: 0.1,
            entity: {
              file_path: 'src/auth.ts',
              code_content: 'export function login() {}',
              start_line: 42,
              end_line: 45,
              language: 'typescript',
              chunk_type: 'function_declaration',
              name: 'login',
            },
          },
        ],
      })

      const service = new RemDbService(defaultConfig)
      const results = await service.search('login', 5)

      // The search method should first embed the query, then call client.search()
      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          collectionName: 'test_collection',
          vector: [0.1, 0.2, 0.3],
          limit: 5,
        }),
      )
      expect(results).toHaveLength(1)
      expect(results[0].filePath).toBe('src/auth.ts')
      expect(results[0].score).toBeCloseTo(0.9)
      expect(results[0].name).toBe('login')
    })
  })

  describe('insertChunks()', () => {
    it('inserts chunks in batches', async () => {
      mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })

      const service = new RemDbService(defaultConfig)
      const count = await service.insertChunks([
        {
          filePath: 'src/test.ts',
          content: 'function foo() {}',
          startLine: 1,
          endLine: 3,
          language: 'typescript',
          chunkType: 'function_declaration',
          name: 'foo',
          vector: [0.1, 0.2, 0.3],
        },
      ])

      expect(count).toBe(1)
      expect(mockInsert).toHaveBeenCalledTimes(1)
    })

    it('returns 0 for empty input', async () => {
      const service = new RemDbService(defaultConfig)
      const count = await service.insertChunks([])
      expect(count).toBe(0)
      expect(mockInsert).not.toHaveBeenCalled()
    })
  })

  describe('deleteByFilePath()', () => {
    it('deletes by file path filter', async () => {
      mockDelete.mockResolvedValue({ code: 0, data: { deleteCount: 3 } })

      const service = new RemDbService(defaultConfig)
      const count = await service.deleteByFilePath('src/test.ts')

      expect(count).toBe(3)
      expect(mockDelete).toHaveBeenCalledWith({
        collectionName: 'test_collection',
        filter: 'file_path == "src/test.ts"',
      })
    })
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Chunker (tree-sitter integration test)
// ═════════════════════════════════════════════════════════════════════════

describe('chunkCode (tree-sitter)', () => {
  it('extracts functions from TypeScript code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-remdb/chunker.js')

    const code = `
function hello(name: string): string {
  return "Hello " + name;
}

class Greeter {
  greet(name: string) {
    return "Hi " + name;
  }
}
`
    const chunks = chunkCode('/tmp/test.ts', code, '.ts')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const func = chunks.find((c) => c.name === 'hello')
    expect(func).toBeDefined()
    expect(func!.chunkType).toBe('function_declaration')
    expect(func!.content).toContain('function hello')

    const method = chunks.find((c) => c.name === 'greet')
    expect(method).toBeDefined()
    expect(method!.chunkType).toBe('method_definition')
  })

  it('extracts functions from Python code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-remdb/chunker.js')

    const code = `
def hello(name):
    return f"Hello {name}"

class Greeter:
    def greet(self, name):
        return f"Hi {name}"
`
    const chunks = chunkCode('/tmp/test.py', code, '.py')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const func = chunks.find((c) => c.name === 'hello')
    expect(func).toBeDefined()
    expect(func!.chunkType).toBe('function_definition')

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_definition')
  })

  it('extracts functions from Rust code', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-remdb/chunker.js')

    const code = `
fn main() {
    println!("Hello");
}

struct User {
    name: String,
}
`
    const chunks = chunkCode('/tmp/test.rs', code, '.rs')
    expect(chunks.length).toBeGreaterThanOrEqual(2)

    const func = chunks.find((c) => c.name === 'main')
    expect(func).toBeDefined()
    expect(func!.chunkType).toBe('function_item')
  })

  it('returns empty array for code with no chunkable structures', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-remdb/chunker.js')

    const chunks = chunkCode('/tmp/test.ts', 'const x = 1;', '.ts')
    expect(chunks).toEqual([])
  })

  it('throws for unsupported extension', async () => {
    const { chunkCode } = await import('../src/plugins/dsh-context-remdb/chunker.js')

    expect(() => chunkCode('/tmp/test.php', '<?php echo "hi";', '.php')).toThrow(
      'Unsupported file extension',
    )
  })
})

// ═════════════════════════════════════════════════════════════════════════
// Indexer pipeline — runIndex
// ═════════════════════════════════════════════════════════════════════════

/** Create a temp directory and populate it with files */
async function createTestDir(
  files: Record<string, string>,
): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'index-test-'))
  for (const [filePath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, filePath)
    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, content, 'utf-8')
  }
  return dir
}

/**
 * Create a smart fetch mock that returns one embedding vector per input text.
 * Used by the real EmbeddingClient inside runIndex().
 */
function createFetchMock(): jest.Mock {
  return jest.fn().mockImplementation(async (_url: string, _options: any) => {
    let numInputs = 1
    try {
      const body = JSON.parse(_options?.body ?? '{}')
      if (Array.isArray(body.input)) {
        numInputs = body.input.length
      }
    } catch {
      // fallback to 1
    }

    const data = Array.from({ length: numInputs }, (_, i) => ({
      embedding: [0.1 + i * 0.1, 0.2 + i * 0.1, 0.3 + i * 0.1],
    }))

    return {
      ok: true,
      json: () => Promise.resolve({ data }),
    }
  })
}

describe('runIndex()', () => {
  let originalFetch: typeof globalThis.fetch

  beforeAll(() => {
    originalFetch = globalThis.fetch
    globalThis.fetch = createFetchMock()
  })

  afterAll(() => {
    globalThis.fetch = originalFetch
  })

  beforeEach(() => {
    mockHasCollection.mockReset()
    mockCreateCollection.mockReset()
    mockInsert.mockReset()
    mockDelete.mockReset()
    mockSearch.mockReset()
  })

  // ── Full mode ─────────────────────────────────────────────────────────

  it('full mode: indexes all files in the directory', async () => {
    const tempDir = await createTestDir({
      'greeter.ts': `
function greet(name: string): string {
  return "Hello " + name;
}
`,
      'math.ts': `
function add(a: number, b: number): number {
  return a + b;
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, remdb, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(2)
    expect(result.chunksIndexed).toBe(2)
    expect(result.filesRemoved).toBe(0)
    expect(result.filesSkipped).toBe(0)
    expect(result.durationMs).toBeGreaterThanOrEqual(0)
    expect(tracker.getStats().totalFiles).toBe(2)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('full mode: re-indexes all files even if already indexed', async () => {
    const tempDir = await createTestDir({
      'hello.ts': `
function hello(): void {
  console.log("hello");
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, remdb, tracker, { mode: 'full' })
    expect(result1.filesIndexed).toBe(1)

    const result2 = await runIndex(config, remdb, tracker, { mode: 'full' })
    expect(result2.filesIndexed).toBe(1)
    expect(result2.filesSkipped).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('full mode: indexes multiple file types (ts, py, rs)', async () => {
    const tempDir = await createTestDir({
      'main.ts': `
function main(): void {
  console.log("hello");
}
`,
      'utils.py': `
def add(a, b):
    return a + b
`,
      'lib.rs': `
fn compute(x: i32) -> i32 {
    x * 2
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, remdb, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(3)
    expect(result.chunksIndexed).toBe(3)

    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Incremental mode ─────────────────────────────────────────────────

  it('incremental mode: first run indexes all files', async () => {
    const tempDir = await createTestDir({
      'app.ts': `
function run(): void {
  // do something
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })
    mockDelete.mockResolvedValue({ code: 0, data: { deleteCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, remdb, tracker, {
      mode: 'incremental',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(1)
    expect(result.filesSkipped).toBe(0)
    expect(result.filesRemoved).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('incremental mode: skips unchanged files on second run', async () => {
    const tempDir = await createTestDir({
      'stable.ts': `
function stable(): string {
  return "I never change";
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })
    mockDelete.mockResolvedValue({ code: 0, data: { deleteCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, remdb, tracker, {
      mode: 'incremental',
    })
    expect(result1.filesIndexed).toBe(1)

    const result2 = await runIndex(config, remdb, tracker, {
      mode: 'incremental',
    })
    expect(result2.filesIndexed).toBe(0)
    expect(result2.filesSkipped).toBe(1)
    expect(result2.filesRemoved).toBe(0)
    expect(mockInsert).toHaveBeenCalledTimes(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('incremental mode: detects modified file and re-indexes it', async () => {
    const tempDir = await createTestDir({
      'changing.ts': `
function original(): string {
  return "original";
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })
    mockDelete.mockResolvedValue({ code: 0, data: { deleteCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, remdb, tracker, {
      mode: 'incremental',
    })
    expect(result1.filesIndexed).toBe(1)

    await writeFile(
      path.join(tempDir, 'changing.ts'),
      `
function updated(): string {
  return "updated";
}
`,
      'utf-8',
    )

    mockInsert.mockClear()
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })
    mockDelete.mockClear()
    mockDelete.mockResolvedValue({ code: 0, data: { deleteCount: 1 } })

    const result2 = await runIndex(config, remdb, tracker, {
      mode: 'incremental',
    })
    expect(result2.filesIndexed).toBe(1)
    expect(result2.filesSkipped).toBe(0)
    expect(result2.filesRemoved).toBe(0)
    expect(mockInsert).toHaveBeenCalledTimes(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('incremental mode: detects deleted file and removes from index', async () => {
    const tempDir = await createTestDir({
      'keep.ts': `
function keep(): string {
  return "keep me";
}
`,
      'remove.ts': `
function remove(): string {
  return "remove me";
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })
    mockDelete.mockResolvedValue({ code: 0, data: { deleteCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result1 = await runIndex(config, remdb, tracker, {
      mode: 'incremental',
    })
    expect(result1.filesIndexed).toBe(2)

    await rm(path.join(tempDir, 'remove.ts'))

    mockInsert.mockClear()
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })
    mockDelete.mockClear()

    const result2 = await runIndex(config, remdb, tracker, {
      mode: 'incremental',
    })
    expect(result2.filesIndexed).toBe(0)
    expect(result2.filesSkipped).toBe(1)
    expect(result2.filesRemoved).toBe(1)
    expect(result2.chunksRemoved).toBe(1)
    expect(tracker.getStats().totalFiles).toBe(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Edge cases ───────────────────────────────────────────────────────

  it('handles an empty directory', async () => {
    const tempDir = await createTestDir({})

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result = await runIndex(config, remdb, tracker, { mode: 'full' })

    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)
    expect(result.filesRemoved).toBe(0)
    expect(result.filesSkipped).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('skips files with no chunkable structures but records hash', async () => {
    const tempDir = await createTestDir({
      'empty.ts': 'const x = 1;',
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result = await runIndex(config, remdb, tracker, { mode: 'full' })

    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)
    expect(tracker.getStats().totalFiles).toBe(1)
    expect(tracker.getStats().totalChunks).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('ignores files with unsupported extensions', async () => {
    const tempDir = await createTestDir({
      'data.txt': 'hello world',
      'notes.md': '# Readme',
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const result = await runIndex(config, remdb, tracker, { mode: 'full' })

    expect(result.filesIndexed).toBe(0)
    expect(result.chunksIndexed).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('skips hidden directories and node_modules', async () => {
    const tempDir = await createTestDir({
      'src/a.ts': `
function a(): void {}
`,
      'node_modules/b.ts': `
function b(): void {}
`,
      '.hidden/c.ts': `
function c(): void {}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })
    mockInsert.mockResolvedValue({ code: 0, data: { insertCount: 1 } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const errors: string[] = []
    const result = await runIndex(config, remdb, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(errors).toEqual([])
    expect(result.filesIndexed).toBe(1)

    await rm(tempDir, { recursive: true, force: true })
  })

  // ── Error handling ───────────────────────────────────────────────────

  it('handles embedding API failure gracefully', async () => {
    const tempDir = await createTestDir({
      'broken.ts': `
function broken(): void {
  throw new Error("broken");
}
`,
    })

    mockHasCollection.mockResolvedValue({ code: 0, data: { has: true } })

    const remdb = new RemDbService({
      endpoint: 'http://localhost:19530',
      token: undefined,
      collection: 'test_collection',
      dim: 768,
      embeddingClient: mockEmbeddingClient(),
    })
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    // Make the embedding API fail
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: () => Promise.resolve('server error'),
    })

    const errors: string[] = []
    const result = await runIndex(config, remdb, tracker, {
      mode: 'full',
      progress: (msg: string) => {
        if (msg.includes('失败')) errors.push(msg)
      },
    })

    expect(result.filesIndexed).toBe(0)
    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors[0]).toContain('失败')
    expect(tracker.getStats().totalFiles).toBe(0)

    await rm(tempDir, { recursive: true, force: true })
  })
})

// ═════════════════════════════════════════════════════════════════════════
// getIndexStatus
// ═════════════════════════════════════════════════════════════════════════

describe('getIndexStatus()', () => {
  it('returns empty state when no files have been indexed', async () => {
    const tempDir = await createTestDir({})
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const status = await getIndexStatus(config, tracker)

    expect(status.totalFiles).toBe(0)
    expect(status.totalChunks).toBe(0)
    expect(status.lastIndexed).toBeUndefined()
    expect(status.indexedExtensions.length).toBeGreaterThan(0)

    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns correct stats after indexing', async () => {
    const tempDir = await createTestDir({
      'a.ts': `
function a(): void {}
`,
      'b.ts': `
function b(): void {}
`,
    })

    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    tracker.updateRecord(
      path.join(tempDir, 'a.ts'),
      'hash-a',
      3,
    )
    tracker.updateRecord(
      path.join(tempDir, 'b.ts'),
      'hash-b',
      2,
    )
    await tracker.save()

    const status = await getIndexStatus(config, tracker)

    expect(status.totalFiles).toBe(2)
    expect(status.totalChunks).toBe(5)
    expect(status.lastIndexed).toBeDefined()
    expect(typeof status.lastIndexed).toBe('string')
    expect(status.indexedExtensions).toContain('.ts')

    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns undefined lastIndexed when tracker has no records', async () => {
    const tempDir = await createTestDir({})
    const tracker = new HashTracker(
      path.join(tempDir, '.merkle.json'),
    )
    const config = getConfig({
      indexRoot: tempDir,
      merkleFilePath: path.join(tempDir, '.merkle.json'),
    })

    const status = await getIndexStatus(config, tracker)

    expect(status.totalFiles).toBe(0)
    expect(status.lastIndexed).toBeUndefined()

    await rm(tempDir, { recursive: true, force: true })
  })
})