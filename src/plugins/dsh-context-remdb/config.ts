/**
 * Configuration management for dsh-context-remdb
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
  /** RemDB server endpoint */
  remdbEndpoint?: string
  /** RemDB auth token */
  remdbToken?: string
  /** RemDB collection name */
  remdbCollection?: string
  /** Vector dimension */
  remdbDim?: number

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

  /** Path to Merkle state file */
  merkleFilePath?: string
}

/** Resolved runtime config (all fields have values) */
export interface PluginConfig {
  remdbEndpoint: string
  remdbToken: string | undefined
  remdbCollection: string
  remdbDim: number
  embedding: EmbeddingConfig
  indexRoot: string
  indexExtensions: string[]
  hybridMode: boolean
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
}

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
    ? `${process.env.HOME}/.remdb-index/merkle-${safeName}-${hash}.json`
    : `.remdb-merkle-${safeName}-${hash}.json`
}

/**
 * Build runtime config from env vars and Cordis config.
 * Cordis config values take precedence over env vars.
 */
export function getConfig(overrides?: CordisConfig): PluginConfig {
  const dimRaw = parseInt(process.env.REMDB_EMBEDDING_DIM ?? '768', 10)
  const dim = overrides?.remdbDim ?? (!isNaN(dimRaw) && dimRaw > 0 ? dimRaw : 768)

  const extensionsStr = overrides?.indexExtensions ?? process.env.INDEX_EXTENSIONS
  const indexExtensions = extensionsStr
    ? extensionsStr.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
    : Object.values(DEFAULT_EXTENSIONS).flat()

  const indexRoot = overrides?.indexRoot ?? process.env.INDEX_ROOT ?? process.cwd()

  return {
    remdbEndpoint: overrides?.remdbEndpoint ?? process.env.REMDB_ENDPOINT ?? 'http://localhost:19530',
    remdbToken: overrides?.remdbToken ?? (process.env.REMDB_TOKEN || undefined),
    remdbCollection: overrides?.remdbCollection ?? process.env.REMDB_COLLECTION ?? 'code_embeddings',
    remdbDim: dim,

    embedding: {
      endpoint: overrides?.embeddingEndpoint ?? process.env.EMBEDDING_ENDPOINT ?? 'http://localhost:19530/v2/vectordb/embedding',
      apiKey: overrides?.embeddingApiKey ?? (process.env.EMBEDDING_API_KEY || undefined),
      model: overrides?.embeddingModel ?? process.env.EMBEDDING_MODEL ?? 'default',
      dim,
    },

    indexRoot,
    indexExtensions,
    hybridMode: overrides?.hybridMode !== undefined
      ? overrides.hybridMode
      : process.env.HYBRID_MODE !== 'false',

    merkleFilePath: overrides?.merkleFilePath ?? process.env.MERKLE_FILE_PATH ?? deriveMerkleFilePath(indexRoot),
  }
}