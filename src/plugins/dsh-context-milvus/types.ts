/**
 * Shared types for dsh-context-milvus
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
  adrId?: string         // frontmatter-derived id (spec/plan files); set during index
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

/** ADR code anchor — links a decision to a code location */
export interface AdrCodeAnchor {
  file: string
  symbols: string[]
  lines: [number, number]
  git_commit: string
}

/** ADR trigger — the requirement that drove this decision */
export interface AdrTrigger {
  task_id: string | null
  requirement_summary: string
  change_type: string
}

/** Parsed ADR frontmatter */
export interface AdrFrontmatter {
  id: string
  type: string
  status: 'active' | 'superseded' | 'deprecated'
  created: string
  updated: string
  author: string
  supersedes: string | null
  superseded_by: string | null
  code_anchors: AdrCodeAnchor[]
  trigger: AdrTrigger
  related_decisions: string[]
  auto_generated: boolean
  confidence_levels?: Record<string, string>
}

/** ADR section chunk (extends CodeChunk with ADR-specific fields) */
export interface AdrChunk {
  filePath: string
  adrId: string
  docType: string
  section: string
  content: string
  startLine: number
  endLine: number
  status: string
  codeAnchors: string[]
  triggerType: string
}

/** ADR search result */
export interface AdrSearchResult {
  adrId: string
  docType: string
  filePath: string
  status: string
  section: string
  content: string
  score: number
  triggerType: string
  codeAnchors: string[]
}

/** ADR list item (for list_adrs tool) */
export interface AdrListItem {
  id: string
  filePath: string
  status: string
  created: string
  updated: string
  anchorCount: number
  summary: string
  changeType: string
}

/** Constraint summary (for load_constraints and re-injection) */
export interface ConstraintSummary {
  adrId: string
  adrTitle: string
  constraints: string[]
  hiddenConstraints: Array<{ name: string; content: string; consequence: string }>
  rejectedPatterns: string[]
  status: string
}

/** ADR index status */
export interface AdrIndexStatus {
  totalAdrs: number
  totalChunks: number
  lastIndexed: string
  activeAdrs: number
}

/** ADR filter params */
export interface AdrFilter {
  status?: string
  changeType?: string
  limit?: number
}

/** Create ADR params */
export interface CreateAdrParams {
  title: string
  requirement?: string
  changeType?: string
  supersedes?: string
  content?: string
}

/** Update ADR params */
export interface UpdateAdrParams {
  content?: string
  status?: string
  supersededBy?: string
  merge?: boolean
}

/** ADR document (fully parsed) */
export interface AdrDocument {
  frontmatter: AdrFrontmatter
  sections: Record<string, string>
  rawContent: string
  filePath: string
}

/** ADR anchor index stats */
export interface AnchorIndexStats {
  adrCount: number
  anchorCount: number
}