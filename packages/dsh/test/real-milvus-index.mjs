/**
 * Real Milvus + Ollama integration test for the indexing pipeline.
 *
 * This script connects to:
 * - Real Milvus server at localhost:19530
 * - Real Ollama server at localhost:11434 (with nomic-embed-text model)
 *
 * Creates a test collection, indexes some code files, and verifies results.
 *
 * Usage:
 *   node --experimental-vm-modules test/real-milvus-index.mjs
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

// Resolve the dist directory
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist', 'plugins', 'dsh-context-milvus')

// ═════════════════════════════════════════════════════════════════════════
// Step 1: Import modules from dist
// ═════════════════════════════════════════════════════════════════════════

const { runIndex } = await import(path.join(distDir, 'indexer.js'))
const { MilvusService } = await import(path.join(distDir, 'milvus-service.js'))
const { HashTracker } = await import(path.join(distDir, 'merkle.js'))
const { getConfig } = await import(path.join(distDir, 'config.js'))

// ═════════════════════════════════════════════════════════════════════════
// Step 2: Create a temporary directory with test code files
// ═════════════════════════════════════════════════════════════════════════

const tempDir = await mkdtemp(path.join(tmpdir(), 'real-milvus-index-test-'))
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
// Step 3: Configure the plugin for real Milvus + Ollama
// ═════════════════════════════════════════════════════════════════════════

const COLLECTION_NAME = 'test_real_milvus_index_' + Date.now()
const MILVUS_ADDRESS = 'localhost:19530'
const OLLAMA_ENDPOINT = 'http://localhost:11434/api/embed'
const EMBEDDING_MODEL = 'nomic-embed-text'
const EMBEDDING_DIM = 768

const config = getConfig({
  milvusAddress: MILVUS_ADDRESS,
  milvusCollection: COLLECTION_NAME,
  milvusDim: EMBEDDING_DIM,
  embeddingEndpoint: OLLAMA_ENDPOINT,
  embeddingModel: EMBEDDING_MODEL,
  indexRoot: tempDir,
  merkleFilePath: path.join(tempDir, '.merkle.json'),
  hybridMode: true,
})

console.log('\nCollection name:', COLLECTION_NAME)
console.log('Milvus address:', config.milvusAddress)
console.log('Ollama endpoint:', config.embedding.endpoint)
console.log('Embedding model:', config.embedding.model)
console.log('Embedding dim:', config.embedding.dim)
console.log('Index extensions:', config.indexExtensions.join(', '))

// Create EmbeddingClient for use by MilvusService (search queries)
const { EmbeddingClient } = await import(path.join(distDir, 'embedding.js'))
const embeddingClient = new EmbeddingClient(config.embedding)

// Create MilvusService with real Milvus client
const milvus = new MilvusService({
  address: config.milvusAddress,
  token: config.milvusToken,
  collection: config.milvusCollection,
  dim: config.milvusDim,
  embeddingClient,
})

// Create HashTracker
const tracker = new HashTracker(config.merkleFilePath)

// ═════════════════════════════════════════════════════════════════════════
// Step 4: Verify Ollama embedding works
// ═════════════════════════════════════════════════════════════════════════

console.log('\n=== Verifying Ollama embedding API ===')
try {
  const testVectors = await embeddingClient.embed(['test code snippet', 'another test'])
  console.log(`  Embedding API OK: ${testVectors.length} vectors, dim=${testVectors[0].length}`)
} catch (err) {
  console.error('  Embedding API FAILED:', err.message)
  process.exit(1)
}

// ═════════════════════════════════════════════════════════════════════════
// Step 5: Run the index
// ═════════════════════════════════════════════════════════════════════════

console.log('\n=== Running index ===')

const progressMessages = []
const result = await runIndex(config, milvus, tracker, {
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

// Query the collection directly using the Milvus SDK
const { MilvusClient } = await import('@zilliz/milvus2-sdk-node')
const client = new MilvusClient({ address: MILVUS_ADDRESS })
await client.connectPromise

// Check collection exists
const hasRes = await client.hasCollection({ collection_name: COLLECTION_NAME })
console.log('  Collection exists:', hasRes.value)

// Query all entities in the collection
if (hasRes.value) {
  const queryRes = await client.query({
    collection_name: COLLECTION_NAME,
    output_fields: ['file_path', 'code_content', 'language', 'chunk_type', 'name', 'start_line', 'end_line'],
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

// Search for a greeting function using the real Ollama embedding
const searchResults = await milvus.search('greeting function', 5)
console.log('  Search results for "greeting function":')
for (const r of searchResults) {
  const relPath = path.relative(tempDir, r.filePath)
  console.log(`    [${r.score.toFixed(4)}] ${relPath}:${r.startLine} "${r.name}" (${r.chunkType})`)
}

// Search for math operations
const mathResults = await milvus.search('mathematical operations', 5)
console.log('  Search results for "mathematical operations":')
for (const r of mathResults) {
  const relPath = path.relative(tempDir, r.filePath)
  console.log(`    [${r.score.toFixed(4)}] ${relPath}:${r.startLine} "${r.name}" (${r.chunkType})`)
}

// Search for Python data processing
const pyResults = await milvus.search('data processing', 5)
console.log('  Search results for "data processing":')
for (const r of pyResults) {
  const relPath = path.relative(tempDir, r.filePath)
  console.log(`    [${r.score.toFixed(4)}] ${relPath}:${r.startLine} "${r.name}" (${r.chunkType})`)
}

// ═════════════════════════════════════════════════════════════════════════
// Step 8: Clean up
// ═════════════════════════════════════════════════════════════════════════

console.log('\n=== Cleanup ===')

// Drop the test collection
await client.dropCollection({ collection_name: COLLECTION_NAME })
console.log('  Collection dropped:', COLLECTION_NAME)

// Delete temp directory
await rm(tempDir, { recursive: true, force: true })
console.log('  Temp dir deleted')

console.log('\n=== Test completed successfully ===')