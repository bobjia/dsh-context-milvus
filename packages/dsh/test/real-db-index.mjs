/**
 * Real RemDB database integration test for the indexing pipeline.
 *
 * This script connects to the real RemDB server at localhost:19530,
 * creates a test collection, indexes some code files, and verifies the results.
 *
 * The embedding API is mocked because the bge-m3 ONNX model file is named
 * 'model.onnx' instead of 'bge-m3.onnx', causing the server to fail to load it.
 *
 * Usage:
 *   node --experimental-vm-modules test/real-db-index.mjs
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Resolve the dist directory
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist', 'plugins', 'dsh-context-remdb')

// ═════════════════════════════════════════════════════════════════════════
// Step 1: Create a custom fetch wrapper that mocks the embedding API
//         while passing through all other requests to the real RemDB server.
// ═════════════════════════════════════════════════════════════════════════

const ORIGINAL_FETCH = globalThis.fetch

// 768-dimensional mock embedding vector (matching bge-m3 model dimension)
function createMockEmbedding(dim = 768, seed = 0.1) {
  return Array.from({ length: dim }, (_, i) => seed + (i % 100) * 0.001)
}

globalThis.fetch = async function realDbFetch(url, options) {
  const urlStr = (typeof url === 'string' ? url : url.toString())

  // Intercept embedding API calls — return mock vectors
  if (urlStr.includes('/v2/vectordb/embedding')) {
    let numInputs = 1
    try {
      const body = JSON.parse(options?.body ?? '{}')
      if (Array.isArray(body.input)) {
        numInputs = body.input.length
      }
    } catch {}
    const data = Array.from({ length: numInputs }, (_, i) => ({
      embedding: createMockEmbedding(768, 0.1 + i * 0.01),
    }))
    return {
      ok: true,
      json: () => Promise.resolve({ data }),
    }
  }

  // All other requests -> real RemDB server
  return ORIGINAL_FETCH(url, options)
}

// ═════════════════════════════════════════════════════════════════════════
// Step 2: Import modules from dist
// ═════════════════════════════════════════════════════════════════════════

const { runIndex } = await import(path.join(distDir, 'indexer.js'))
const { RemDbService } = await import(path.join(distDir, 'remdb-service.js'))
const { HashTracker } = await import(path.join(distDir, 'merkle.js'))
const { getConfig } = await import(path.join(distDir, 'config.js'))

// ═════════════════════════════════════════════════════════════════════════
// Step 3: Create a temporary directory with test code files
// ═════════════════════════════════════════════════════════════════════════

const tempDir = await mkdtemp(path.join(tmpdir(), 'real-db-index-test-'))
console.log('Temp dir:', tempDir)

// Create some test files with various code structures
const files = {
  'src/greeter.ts': `
/**
 * A simple greeter class.
 */
export class Greeter {
  private name: string

  constructor(name: string) {
    this.name = name
  }

  greet(): string {
    return \`Hello, \${this.name}!\`
  }
}

export function createGreeter(name: string): Greeter {
  return new Greeter(name)
}
`,
  'src/math.ts': `
export function add(a: number, b: number): number {
  return a + b
}

export function multiply(a: number, b: number): number {
  return a * b
}
`,
  'src/utils.py': `
def parse_json(text):
    import json
    return json.loads(text)

class DataProcessor:
    def __init__(self, prefix):
        self.prefix = prefix

    def process(self, data):
        return {self.prefix + k: v for k, v in data.items()}
`,
  'src/lib.rs': `
pub struct Config {
    pub host: String,
    pub port: u16,
}

impl Config {
    pub fn new(host: &str, port: u16) -> Self {
        Self {
            host: host.to_string(),
            port,
        }
    }

    pub fn addr(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

pub fn connect(config: &Config) -> Result<String, String> {
    Ok(format!("Connected to {}", config.addr()))
}
`,
}

for (const [filePath, content] of Object.entries(files)) {
  const fullPath = path.join(tempDir, filePath)
  await mkdir(path.dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content, 'utf-8')
  console.log('  Created:', filePath)
}

// ═════════════════════════════════════════════════════════════════════════
// Step 4: Configure the plugin for real RemDB
// ═════════════════════════════════════════════════════════════════════════

const COLLECTION_NAME = 'test_real_db_index_' + Date.now()

const config = getConfig({
  remdbEndpoint: 'http://localhost:19530',
  remdbCollection: COLLECTION_NAME,
  remdbDim: 768,
  embeddingEndpoint: 'http://localhost:19530/v2/vectordb/embedding',
  embeddingModel: 'bge-m3',
  indexRoot: tempDir,
  merkleFilePath: path.join(tempDir, '.merkle.json'),
  hybridMode: true,
})

console.log('\nCollection name:', COLLECTION_NAME)
console.log('RemDB endpoint:', config.remdbEndpoint)
console.log('Index extensions:', config.indexExtensions.join(', '))

// Create a mock embedding client for the RemDbService constructor
// (only used for search(), not for indexing)
const mockEmbedClient = {
  embed: async () => [createMockEmbedding(768)],
}

// Create RemDbService with real RemDB client
const remdb = new RemDbService({
  endpoint: config.remdbEndpoint,
  token: config.remdbToken,
  collection: config.remdbCollection,
  dim: config.remdbDim,
  embeddingClient: mockEmbedClient,
})

// Create HashTracker
const tracker = new HashTracker(config.merkleFilePath)

// ═════════════════════════════════════════════════════════════════════════
// Step 5: Run the index
// ═════════════════════════════════════════════════════════════════════════

console.log('\n=== Running index ===')

const progressMessages = []
const result = await runIndex(config, remdb, tracker, {
  mode: 'full',
  progress: (msg) => {
    progressMessages.push(msg)
    console.log('  [progress]', msg)
  },
})

console.log('\n=== Index result ===')
console.log('  Files indexed:', result.filesIndexed)
console.log('  Chunks indexed:', result.chunksIndexed)
console.log('  Files removed:', result.filesRemoved)
console.log('  Chunks removed:', result.chunksRemoved)
console.log('  Files skipped:', result.filesSkipped)
console.log('  Duration:', result.durationMs, 'ms')

// ═════════════════════════════════════════════════════════════════════════
// Step 6: Verify the indexed data
// ═════════════════════════════════════════════════════════════════════════

console.log('\n=== Verification ===')

// Check tracker stats
const stats = tracker.getStats()
console.log('  Tracker files:', stats.totalFiles)
console.log('  Tracker chunks:', stats.totalChunks)

// Query the collection directly using the RemDB SDK
const { RemDbClient } = await import('remdb-sdk-node')
const client = new RemDbClient({
  endpoint: config.remdbEndpoint,
  token: config.remdbToken,
  timeout: 10_000,
})

// Check collection exists
const hasRes = await client.hasCollection({ collectionName: COLLECTION_NAME })
console.log('  Collection exists:', hasRes.data?.has)

// Query all entities in the collection
if (hasRes.data?.has) {
  // Use the query API to get all entities
  const queryRes = await client.query({
    collectionName: COLLECTION_NAME,
    outputFields: ['file_path', 'code_content', 'language', 'chunk_type', 'name', 'start_line', 'end_line'],
    limit: 100,
  })
  const entities = queryRes.data ?? []
  console.log('  Total entities in collection:', entities.length)

  // Group by file
  const byFile = {}
  for (const entity of entities) {
    const fp = entity.file_path || 'unknown'
    if (!byFile[fp]) byFile[fp] = []
    byFile[fp].push(entity)
  }

  console.log('\n  Files in collection:')
  for (const [fp, chunks] of Object.entries(byFile)) {
    const relPath = path.relative(tempDir, fp)
    console.log(`    ${relPath}: ${chunks.length} chunks`)
    for (const chunk of chunks) {
      console.log(`      - ${chunk.chunk_type} "${chunk.name}" (lines ${chunk.start_line}-${chunk.end_line})`)
    }
  }
}

// ═════════════════════════════════════════════════════════════════════════
// Step 7: Search test
// ═════════════════════════════════════════════════════════════════════════

console.log('\n=== Search test ===')

// Use the RemDbService search method (which uses the mocked embedding client)
const searchResults = await remdb.search('greeting function', 5)
console.log('  Search results for "greeting function":')
for (const r of searchResults) {
  const relPath = path.relative(tempDir, r.filePath)
  console.log(`    [${r.score.toFixed(4)}] ${relPath}:${r.startLine} "${r.name}" (${r.chunkType})`)
}

// ═════════════════════════════════════════════════════════════════════════
// Step 8: Clean up
// ═════════════════════════════════════════════════════════════════════════

console.log('\n=== Cleanup ===')

// Drop the test collection
await client.dropCollection({ collectionName: COLLECTION_NAME })
console.log('  Collection dropped:', COLLECTION_NAME)

// Delete temp directory
await rm(tempDir, { recursive: true, force: true })
console.log('  Temp dir deleted')

// Restore original fetch
globalThis.fetch = ORIGINAL_FETCH

console.log('\n=== Test completed successfully ===')