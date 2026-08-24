/**
 * Shared types for dsh-context-remdb
 */

/** 代码块（从 AST 中提取的语义单元） */
export interface CodeChunk {
  filePath: string
  content: string
  startLine: number
  endLine: number
  language: string
  chunkType: string   // e.g. 'function', 'class', 'method', 'interface'
  name: string        // e.g. function name, class name
}

/** 搜索结果（供 Agent 消费） */
export interface SearchResult {
  filePath: string
  content: string
  score: number
  language: string
  startLine: number
  endLine: number
  name: string
  chunkType: string
}

/** 索引状态 */
export interface IndexStatus {
  totalFiles: number
  totalChunks: number
  lastIndexed?: string   // ISO timestamp
  indexedExtensions: string[]
}

/** 文件哈希记录（Merkle 状态） */
export interface HashRecord {
  filePath: string
  hash: string
  lastIndexed: number    // Unix timestamp ms
  chunkCount: number
}

/** Merkle 状态快照 */
export interface MerkleState {
  version: number
  records: HashRecord[]
}

/** Embedding 配置 */
export interface EmbeddingConfig {
  endpoint: string
  apiKey?: string
  model: string
  dim: number
}

/** 语言配置 */
export interface LanguageConfig {
  name: string
  extensions: string[]
  chunkNodeTypes: string[]
}