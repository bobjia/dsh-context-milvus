/**
 * Configuration management for dsh-context-milvus
 *
 * Supports two sources (merged, config takes precedence):
 * 1. Environment variables (for quick setup)
 * 2. Cordis Config (passed from apply(ctx, config), for DSH integration)
 */

import { createHash } from 'node:crypto'
import * as path from 'node:path'
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
  /** Directory names to ignore during indexing (comma-separated) */
  indexIgnoreDirs?: string

  /** Path to Merkle state file */
  merkleFilePath?: string
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
  indexIgnoreDirs: string[]
  merkleFilePath: string
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
}

/** Default directory names to ignore during indexing */
export const DEFAULT_IGNORE_DIRS = [
  'dist', 'build', 'target', 'out',
  '__pycache__', 'vendor', 'bower_components',
  'coverage', '.nyc_output',
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
    hybridMode: overrides?.hybridMode !== undefined
      ? overrides.hybridMode
      : process.env.HYBRID_MODE !== 'false',

    merkleFilePath: overrides?.merkleFilePath ?? process.env.MERKLE_FILE_PATH ?? deriveMerkleFilePath(indexRoot),
  }
}