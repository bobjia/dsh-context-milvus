/**
 * Configuration management for dsh-context-milvus
 *
 * Supports two sources (merged, config takes precedence):
 * 1. Environment variables (for quick setup)
 * 2. Cordis Config (passed from apply(ctx, config), for DSH integration)
 */

import { createHash } from 'node:crypto'
import * as path from 'node:path'
import * as os from 'node:os'
import type { EmbeddingConfig } from './types.js'

/** Flat config interface that users provide via cordis.yml or env vars */
export interface CordisConfig {
  /** Milvus server address (host:port) */
  milvusAddress?: string
  /** Milvus auth token */
  milvusToken?: string
  /** Milvus collection name */
  milvusCollection?: string
  /** Vector dimension */
  milvusDim?: number

  /** Embedding API endpoint */
  embeddingEndpoint?: string
  /** Embedding API key */
  embeddingApiKey?: string
  /** Embedding model name */
  embeddingModel?: string

  /** Root directory for code indexing */
  indexRoot?: string
  /** File extensions to index (comma-separated) */
  indexExtensions?: string
  /** Enable hybrid search (BM25 + vector) */
  hybridMode?: boolean
  /** RRF 融合参数 k（越高越偏向名次，默认 60） */
  bm25RrfK?: number
  /** Directory names to ignore during indexing (comma-separated) */
  indexIgnoreDirs?: string
  /** Custom ignore patterns (gitignore-style, comma-separated) */
  ignorePatterns?: string

  /** Path to Merkle state file */
  merkleFilePath?: string

  /** 启用本地遥测（JSONL，默认关闭） */
  telemetryEnabled?: boolean
  /** 遥测 JSONL 文件路径（留空用默认 ~/.milvus-index/telemetry.jsonl） */
  telemetryFile?: string

  /** Enable ADR (decision memory) features */
  adrEnabled?: boolean
  /** ADR directory relative to indexRoot */
  adrRoot?: string
  /** Milvus collection name for ADR embeddings */
  adrCollection?: string
  /** Steps between constraint re-injection (0=disable) */
  adrConstraintReinjectEvery?: number
  /** Custom system prompt section for ADR rules (empty=use default) */
  adrSystemPrompt?: string

  /** 规格文档目录（相对 indexRoot） */
  specRoot?: string
  /** 实现计划目录（相对 indexRoot） */
  planRoot?: string
}

/** Resolved runtime config (all fields have values) */
export interface PluginConfig {
  milvusAddress: string
  milvusToken: string | undefined
  milvusCollection: string
  milvusDim: number
  embedding: EmbeddingConfig
  indexRoot: string
  indexExtensions: string[]
  hybridMode: boolean
  bm25RrfK: number
  indexIgnoreDirs: string[]
  ignorePatterns: string[]
  merkleFilePath: string
  telemetryEnabled: boolean
  telemetryFile: string
  adrEnabled: boolean
  adrRoot: string
  adrCollection: string
  adrConstraintReinjectEvery: number
  adrSystemPrompt: string
  specRoot: string
  planRoot: string
}

/** Default file extensions to index, keyed by language */
export const DEFAULT_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  php: ['.php'],
  cpp: ['.cpp', '.cxx', '.cc', '.hpp', '.h', '.hh'],
  csharp: ['.cs'],
  scala: ['.scala'],
}

/** Default directory names to ignore during indexing */
export const DEFAULT_IGNORE_DIRS = [
  'dist', 'build', 'target', 'out',
  '__pycache__', 'vendor', 'bower_components',
  'coverage', '.nyc_output',
]

/** Default gitignore-style ignore patterns */
export const DEFAULT_IGNORE_PATTERNS = [
  // Build output and dependency directories
  'node_modules/**',
  'dist/**', 'build/**', 'out/**',
  'target/**', 'coverage/**', '.nyc_output/**',

  // IDE and editor files
  '.vscode/**', '.idea/**',
  '*.swp', '*.swo',

  // Version control
  '.git/**', '.svn/**', '.hg/**',

  // Cache directories
  '.cache/**', '__pycache__/**', '.pytest_cache/**',

  // Logs and temporary files
  'logs/**', 'tmp/**', 'temp/**',
  '*.log',

  // Environment config
  '.env', '.env.*', '*.local',

  // Minified and bundled files
  '*.min.js', '*.min.css', '*.bundle.js', '*.map',

  // Directory names (bare, for gitignore-style dir matching)
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'target',
  '.vscode', '.idea', '__pycache__', '.pytest_cache',
  'coverage', '.nyc_output', 'logs', 'tmp', 'temp',
]

/**
 * Derive a workspace-specific Merkle state file path from an index root path.
 * Each workspace gets its own state file, so indexing different workspaces
 * doesn't corrupt the Merkle state.
 *
 * @param indexRoot - The index root path (absolute path to workspace)
 * @returns An absolute path to the Merkle state file for this workspace
 */
export function deriveMerkleFilePath(indexRoot: string): string {
  // Normalize the path to handle symlinks, etc.
  const normalizedPath = path.resolve(indexRoot)
  // Create a hash of the path to use as a unique identifier
  const hash = createHash('sha256').update(normalizedPath, 'utf-8').digest('hex').slice(0, 16)
  // Use the workspace directory name for readability
  const dirName = path.basename(normalizedPath) || 'root'
  // Sanitize dirName for use in a file name
  const safeName = dirName.replace(/[^a-zA-Z0-9_\-]/g, '_')

  return process.env.HOME
    ? `${process.env.HOME}/.milvus-index/merkle-${safeName}-${hash}.json`
    : `.milvus-merkle-${safeName}-${hash}.json`
}

/**
 * Derive the import map file path for a given root path.
 * Uses the same approach as deriveMerkleFilePath but with a different prefix.
 */
export function deriveImportMapFilePath(rootPath: string): string {
  const hash = createHash('sha256').update(rootPath).digest('hex').slice(0, 16)
  const baseDir = path.join(os.homedir(), '.milvus-index')
  return path.join(baseDir, `import-map-${hash}.json`)
}

/**
 * Build runtime config from env vars and Cordis config.
 * Cordis config values take precedence over env vars.
 */
export function getConfig(overrides?: CordisConfig): PluginConfig {
  const dimRaw = parseInt(process.env.MILVUS_EMBEDDING_DIM ?? '768', 10)
  const dim = overrides?.milvusDim ?? (!isNaN(dimRaw) && dimRaw > 0 ? dimRaw : 768)

  const extensionsStr = overrides?.indexExtensions ?? process.env.INDEX_EXTENSIONS
  const indexExtensions = extensionsStr
    ? extensionsStr.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : Object.values(DEFAULT_EXTENSIONS).flat()

  const ignoreDirsStr = overrides?.indexIgnoreDirs ?? process.env.INDEX_IGNORE_DIRS
  const indexIgnoreDirs = ignoreDirsStr
    ? ignoreDirsStr.split(',').map((s) => s.trim()).filter(Boolean)
    : DEFAULT_IGNORE_DIRS

  const indexRoot = overrides?.indexRoot ?? process.env.INDEX_ROOT ?? process.cwd()

  // Convert indexIgnoreDirs to gitignore-style patterns (backward compat)
  const dirPatterns = indexIgnoreDirs.map(dir => `**/${dir}/**`)

  // Parse custom ignore patterns
  const customPatternsStr = overrides?.ignorePatterns ?? process.env.IGNORE_PATTERNS
  const customPatterns = customPatternsStr
    ? customPatternsStr.split(',').map((s) => s.trim()).filter(Boolean)
    : []

  const rrfKRaw = parseInt(process.env.BM25_RRF_K ?? '', 10)
  const bm25RrfK = overrides?.bm25RrfK ?? (!isNaN(rrfKRaw) && rrfKRaw > 0 ? rrfKRaw : 60)

  return {
    milvusAddress: overrides?.milvusAddress ?? process.env.MILVUS_ADDRESS ?? 'localhost:19530',
    milvusToken: overrides?.milvusToken ?? (process.env.MILVUS_TOKEN || undefined),
    milvusCollection: overrides?.milvusCollection ?? process.env.MILVUS_COLLECTION ?? 'code_embeddings',
    milvusDim: dim,

    embedding: {
      endpoint: overrides?.embeddingEndpoint ?? process.env.EMBEDDING_ENDPOINT ?? 'http://localhost:11434/api/embed',
      apiKey: overrides?.embeddingApiKey ?? (process.env.EMBEDDING_API_KEY || undefined),
      model: overrides?.embeddingModel ?? process.env.EMBEDDING_MODEL ?? 'nomic-embed-text',
      dim,
    },

    indexRoot,
    indexExtensions,
    indexIgnoreDirs,
    ignorePatterns: [...dirPatterns, ...customPatterns],
    hybridMode: overrides?.hybridMode !== undefined
      ? overrides.hybridMode
      : process.env.HYBRID_MODE !== 'false',

    bm25RrfK,

    merkleFilePath: overrides?.merkleFilePath ?? process.env.MERKLE_FILE_PATH ?? deriveMerkleFilePath(indexRoot),

    telemetryEnabled: overrides?.telemetryEnabled ?? false,
    telemetryFile: overrides?.telemetryFile ?? path.join(os.homedir(), '.milvus-index', 'telemetry.jsonl'),

    adrEnabled: overrides?.adrEnabled ?? false,
    adrRoot: overrides?.adrRoot ?? 'docs/decisions',
    adrCollection: overrides?.adrCollection ?? 'adr_embeddings',
    adrConstraintReinjectEvery: overrides?.adrConstraintReinjectEvery ?? 0,
    adrSystemPrompt: overrides?.adrSystemPrompt ?? '',
    specRoot: overrides?.specRoot ?? process.env.SPEC_ROOT ?? 'docs/superpowers/specs',
    planRoot: overrides?.planRoot ?? process.env.PLAN_ROOT ?? 'docs/superpowers/plans',
  }
}