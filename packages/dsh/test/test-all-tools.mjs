/**
 * 端到端工具测试 — 测试所有三个 DSH 工具
 *
 * 连接真实 Milvus + Ollama，测试:
 *   - index_code   (全量/增量/路径覆盖)
 *   - search_code  (语义搜索/路径过滤)
 *   - index_status (状态查询)
 *
 * Usage:
 *   node --experimental-vm-modules test/test-all-tools.mjs
 */

import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const distDir = path.resolve(__dirname, '..', 'dist', 'plugins', 'dsh-context-milvus')

// ═════════════════════════════════════════════════════════════════════════
// 0. 导入模块
// ═════════════════════════════════════════════════════════════════════════

const { runIndex, getIndexStatus } = await import(path.join(distDir, 'indexer.js'))
const { MilvusService } = await import(path.join(distDir, 'milvus-service.js'))
const { HashTracker } = await import(path.join(distDir, 'merkle.js'))
const { getConfig } = await import(path.join(distDir, 'config.js'))
const { EmbeddingClient } = await import(path.join(distDir, 'embedding.js'))
const { registerTools } = await import(path.join(distDir, 'tools.js'))

let passed = 0
let failed = 0

function assert(condition, message) {
  if (condition) {
    passed++
    console.log(`  ✓ ${message}`)
  } else {
    failed++
    console.error(`  ✗ ${message}`)
  }
}

// ═════════════════════════════════════════════════════════════════════════
// 1. 准备测试环境
// ═════════════════════════════════════════════════════════════════════════

const COLLECTION_NAME = 'test_all_tools_' + Date.now()
const tempDir = await mkdtemp(path.join(tmpdir(), 'all-tools-test-'))
console.log('Collection:', COLLECTION_NAME)
console.log('Temp dir:', tempDir)

// 创建测试代码文件
const files = {
  'src/greeter.ts': `
export class Greeter {
  private name: string
  constructor(name: string) { this.name = name }
  greet(): string { return \`Hello, \${this.name}!\` }
}
export function createGreeter(name: string): Greeter {
  return new Greeter(name)
}
`,
  'src/math.ts': `
export function add(a: number, b: number): number { return a + b }
export function multiply(a: number, b: number): number { return a * b }
`,
  'src/utils.py': `
def parse_json(text):
    import json
    return json.loads(text)
class DataProcessor:
    def __init__(self, prefix): self.prefix = prefix
    def process(self, data):
        return {self.prefix + k: v for k, v in data.items()}
`,
  'src/lib.rs': `
pub struct Config { pub host: String, pub port: u16 }
impl Config {
    pub fn new(host: &str, port: u16) -> Self {
        Self { host: host.to_string(), port }
    }
    pub fn addr(&self) -> String { format!("{}:{}", self.host, self.port) }
}
pub fn connect(config: &Config) -> Result<String, String> {
    Ok(format!("Connected to {}", config.addr()))
}
`,
}

for (const [fp, content] of Object.entries(files)) {
  const fullPath = path.join(tempDir, fp)
  await mkdir(path.dirname(fullPath), { recursive: true })
  await writeFile(fullPath, content, 'utf-8')
}

// 配置
const config = getConfig({
  milvusAddress: 'localhost:19530',
  milvusCollection: COLLECTION_NAME,
  milvusDim: 768,
  embeddingEndpoint: 'http://localhost:11434/api/embed',
  embeddingModel: 'nomic-embed-text',
  indexRoot: tempDir,
  merkleFilePath: path.join(tempDir, '.merkle.json'),
  hybridMode: true,
})

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  工具 1: index_code — 全量索引')
console.log('══════════════════════════════════════════════════════════════')

const embeddingClient = new EmbeddingClient(config.embedding)
const milvus = new MilvusService({
  address: config.milvusAddress,
  token: config.milvusToken,
  collection: config.milvusCollection,
  dim: config.milvusDim,
  embeddingClient,
})
const tracker = new HashTracker(config.merkleFilePath)

// -- 全量索引 --
const fullResult = await runIndex(config, milvus, tracker, { mode: 'full' })
assert(fullResult.filesIndexed === 4, `index_code full: 索引了 ${fullResult.filesIndexed} 个文件`)
assert(fullResult.chunksIndexed === 11, `index_code full: 产生了 ${fullResult.chunksIndexed} 个代码块`)
assert(fullResult.filesRemoved === 0, 'index_code full: 没有文件被删除')
assert(fullResult.durationMs > 0, 'index_code full: 耗时记录正确')

// 验证 Merkle 状态
const stats = tracker.getStats()
assert(stats.totalFiles === 4, `index_code full: Merkle 记录 ${stats.totalFiles} 个文件`)
assert(stats.totalChunks === 11, `index_code full: Merkle 记录 ${stats.totalChunks} 个代码块`)

// 验证 Milvus 数据
const { MilvusClient } = await import('@zilliz/milvus2-sdk-node')
const client = new MilvusClient({ address: config.milvusAddress })
await client.connectPromise
const hasRes = await client.hasCollection({ collection_name: COLLECTION_NAME })
assert(hasRes.value === true, 'index_code full: 集合已创建')
const queryRes = await client.query({
  collection_name: COLLECTION_NAME,
  output_fields: ['file_path'],
  limit: 100,
})
assert(queryRes.data.length === 11, `index_code full: Milvus 中有 ${queryRes.data.length} 条记录`)

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  工具 2: index_code — 增量索引')
console.log('══════════════════════════════════════════════════════════════')

// -- 增量索引（无变化）--
const incrResult1 = await runIndex(config, milvus, tracker, { mode: 'incremental' })
assert(incrResult1.filesIndexed === 0, 'index_code incremental (unchanged): 没有新文件')
assert(incrResult1.filesSkipped === 4, `index_code incremental (unchanged): 跳过了 ${incrResult1.filesSkipped} 个文件`)

// -- 修改一个文件 --
await writeFile(path.join(tempDir, 'src/math.ts'), `
export function add(a: number, b: number): number { return a + b }
export function multiply(a: number, b: number): number { return a * b }
export function divide(a: number, b: number): number { return a / b }
`, 'utf-8')

const incrResult2 = await runIndex(config, milvus, tracker, { mode: 'incremental' })
assert(incrResult2.filesIndexed === 1, `index_code incremental (modified): 重新索引了 ${incrResult2.filesIndexed} 个文件`)
assert(incrResult2.filesSkipped === 3, `index_code incremental (modified): 跳过了 ${incrResult2.filesSkipped} 个文件`)

// -- 删除一个文件 --
await rm(path.join(tempDir, 'src/lib.rs'))

const incrResult3 = await runIndex(config, milvus, tracker, { mode: 'incremental' })
assert(incrResult3.filesRemoved === 1, `index_code incremental (deleted): 移除了 ${incrResult3.filesRemoved} 个文件`)
assert(incrResult3.chunksRemoved >= 3, `index_code incremental (deleted): 移除了 ${incrResult3.chunksRemoved} 个代码块`)
assert(tracker.getStats().totalFiles === 3, `index_code incremental (deleted): Merkle 剩余 ${tracker.getStats().totalFiles} 个文件`)

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  工具 3: search_code — 语义搜索')
console.log('══════════════════════════════════════════════════════════════')

// -- 搜索 greeting 相关 --
const greetResults = await milvus.search('greeting function', 5)
assert(greetResults.length > 0, 'search_code: 返回了结果')
assert(greetResults[0].score > 0, 'search_code: 分数正确')
const greetTop = greetResults.find(r => r.name === 'greet')
assert(greetTop !== undefined, 'search_code: "greet" 方法被找到')
assert(greetTop.score > 0.6, `search_code: "greet" 相关度 ${greetTop.score.toFixed(4)} > 0.6`)

console.log('  Top 5 results for "greeting function":')
for (const r of greetResults) {
  console.log(`    [${r.score.toFixed(4)}] ${path.relative(tempDir, r.filePath)}:${r.startLine} "${r.name}" (${r.chunkType})`)
}

// -- 搜索 math 相关 --
const mathResults = await milvus.search('mathematical operations', 5)
assert(mathResults.length > 0, 'search_code: math 搜索返回了结果')
const mathTop = mathResults.find(r => r.name === 'multiply' || r.name === 'add')
assert(mathTop !== undefined, 'search_code: math 函数被找到')

console.log('  Top 5 results for "mathematical operations":')
for (const r of mathResults) {
  console.log(`    [${r.score.toFixed(4)}] ${path.relative(tempDir, r.filePath)}:${r.startLine} "${r.name}" (${r.chunkType})`)
}

// -- 搜索 Python 相关 --
const pyResults = await milvus.search('data processing python', 5)
assert(pyResults.length > 0, 'search_code: Python 搜索返回了结果')
const pyTop = pyResults.find(r => r.name === 'DataProcessor' || r.name === 'parse_json')
assert(pyTop !== undefined, 'search_code: Python 函数被找到')

console.log('  Top 5 results for "data processing python":')
for (const r of pyResults) {
  console.log(`    [${r.score.toFixed(4)}] ${path.relative(tempDir, r.filePath)}:${r.startLine} "${r.name}" (${r.chunkType})`)
}

// -- 搜索路径过滤 --
const pathFiltered = await milvus.search('function', 5, path.join(tempDir, 'src/math.ts'))
assert(pathFiltered.length > 0, 'search_code: 路径过滤返回了结果')
for (const r of pathFiltered) {
  assert(r.filePath.startsWith(path.join(tempDir, 'src/math.ts')), 'search_code: 结果路径正确过滤')
}
console.log(`  Path-filtered search (math.ts only): ${pathFiltered.length} results`)

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  工具 4: index_status — 状态查询')
console.log('══════════════════════════════════════════════════════════════')

// -- 默认路径状态 --
const status = await getIndexStatus(config, tracker)
assert(status.totalFiles === 3, `index_status: 共 ${status.totalFiles} 个文件`)
assert(status.totalChunks === 9, `index_status: 共 ${status.totalChunks} 个代码块`) // 11 - 3 (lib.rs) + 1 (divide) = 9
assert(typeof status.lastIndexed === 'string', 'index_status: 最后索引时间正确')
assert(status.indexedExtensions.includes('.ts'), 'index_status: 支持的文件类型正确')

console.log(`  Files: ${status.totalFiles}`)
console.log(`  Chunks: ${status.totalChunks}`)
console.log(`  Last indexed: ${status.lastIndexed}`)
console.log(`  Extensions: ${status.indexedExtensions.join(', ')}`)

// -- 自定义路径状态 --
const customStatus = await getIndexStatus(
  { ...config, indexRoot: '/tmp/nonexistent', merkleFilePath: path.join(tempDir, '.custom-merkle.json') },
  new HashTracker(path.join(tempDir, '.custom-merkle.json')),
)
assert(customStatus.totalFiles === 0, 'index_status: 空路径状态正确')
assert(customStatus.lastIndexed === undefined, 'index_status: 未索引时 lastIndexed 为 undefined')

console.log('\n══════════════════════════════════════════════════════════════')
console.log('  工具注册测试')
console.log('══════════════════════════════════════════════════════════════')

// 测试 registerTools 函数
const registeredTools = []
const mockCtx = {
  tools: {
    register: (toolDef) => {
      registeredTools.push(toolDef)
      return toolDef
    },
  },
}

registerTools(mockCtx, config, milvus, tracker)
assert(registeredTools.length === 3, `registerTools: 注册了 ${registeredTools.length} 个工具`)
const toolNames = registeredTools.map(t => t.name).sort()
assert(toolNames[0] === 'index_code', 'registerTools: index_code 已注册')
assert(toolNames[1] === 'index_status', 'registerTools: index_status 已注册')
assert(toolNames[2] === 'search_code', 'registerTools: search_code 已注册')
assert(typeof registeredTools[0].execute === 'function', 'registerTools: 每个工具都有 execute 函数')
const firstTool = registeredTools[0]
const hasRender = typeof firstTool.render === 'function' ||
  (firstTool.output && typeof firstTool.output.render === 'function')
assert(hasRender, 'registerTools: 每个工具都有 render 函数')

console.log('  Registered tools:', toolNames.join(', '))

// ═════════════════════════════════════════════════════════════════════════
// 清理
// ═════════════════════════════════════════════════════════════════════════

await client.dropCollection({ collection_name: COLLECTION_NAME })
await rm(tempDir, { recursive: true, force: true })

console.log('\n══════════════════════════════════════════════════════════════')
console.log(`  结果: ${passed} 通过, ${failed} 失败`)
console.log('══════════════════════════════════════════════════════════════')

if (failed > 0) {
  process.exit(1)
}