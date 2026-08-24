/**
 * Configuration management for dsh-context-remdb
 *
 * Supports two sources (merged, config takes precedence):
 * 1. Environment variables (for quick setup)
 * 2. Cordis Config (passed from apply(ctx, config), for DSH integration)
 */

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

    indexRoot: overrides?.indexRoot ?? process.env.INDEX_ROOT ?? process.cwd(),
    indexExtensions,
    hybridMode: overrides?.hybridMode !== undefined
      ? overrides.hybridMode
      : process.env.HYBRID_MODE !== 'false',

    merkleFilePath: overrides?.merkleFilePath ?? process.env.MERKLE_FILE_PATH ?? (
      process.env.HOME
        ? `${process.env.HOME}/.remdb-index/merkle.json`
        : '.remdb-merkle.json'
    ),
  }
}