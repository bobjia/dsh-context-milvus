/**
 * dsh-context-milvus — DSH plugin entry point
 *
 * A complete index ↔ search plugin for semantic code search via Milvus.
 * - search_code: 语义搜索代码
 * - index_code:  索引代码仓库
 * - index_status: 查看索引状态
 *
 * Configuration (优先顺序: Cordis Config > 环境变量 > 默认值):
 *
 *   Cordis Config (通过 cordis.yml / DSH GUI 设置):
 *     milvusAddress, milvusToken, milvusCollection, milvusDim,
 *     embeddingEndpoint, embeddingApiKey, embeddingModel,
 *     indexRoot, indexExtensions, indexIgnoreDirs, hybridMode, bm25RrfK, merkleFilePath
 *
 *   环境变量 (fallback):
 *     MILVUS_ADDRESS, MILVUS_TOKEN, MILVUS_COLLECTION, MILVUS_EMBEDDING_DIM,
 *     EMBEDDING_ENDPOINT, EMBEDDING_API_KEY, EMBEDDING_MODEL,
 *     INDEX_ROOT, INDEX_EXTENSIONS, INDEX_IGNORE_DIRS, HYBRID_MODE, BM25_RRF_K, MERKLE_FILE_PATH
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { getConfig, type CordisConfig } from './config.js'
import { MilvusService } from './milvus-service.js'
import { HashTracker } from './merkle.js'
import { EmbeddingClient } from './embedding.js'
import { registerTools } from './tools.js'

export const name = 'dsh-context-milvus'
export const inject = ['tools']

/** Settings namespace for dsh-context-milvus configuration */
const SETTINGS_NAMESPACE = settingsNamespace('dsh-context-milvus')

/**
 * Config schema for dsh-context-milvus.
 *
 * This schema is used by:
 * - Cordis loader for config validation before the plugin starts
 * - DSH Web GUI (Settings → Plugins) for auto-generated configuration UI
 *
 * Fields with `.role('secret')` are rendered as password inputs in the GUI.
 * Fields with `.description(...)` show tooltips/labels in the GUI.
 */
export const Config = z.object({
  /** Milvus 服务地址 */
  milvusAddress: z.string()
    .default('localhost:19530')
    .description('Milvus 服务地址，例如 localhost:19530'),

  /** Milvus 鉴权 Token (可选) */
  milvusToken: z.string()
    .default('')
    .description('Milvus 鉴权 Token（如不需要可留空）')
    .role('secret'),

  /** Milvus 集合名称 */
  milvusCollection: z.string()
    .default('code_embeddings')
    .description('Milvus 集合名称，用于存储代码向量'),

  /** 向量维度 */
  milvusDim: z.number()
    .default(768)
    .description('Embedding 向量维度（需与模型匹配）'),

  /** Embedding API 地址 */
  embeddingEndpoint: z.string()
    .default('http://localhost:11434/api/embed')
    .description('Embedding API 地址（例如 Ollama: http://localhost:11434/api/embed）'),

  /** Embedding API 密钥 (可选) */
  embeddingApiKey: z.string()
    .default('')
    .description('Embedding API 密钥（如不需要可留空）')
    .role('secret'),

  /** Embedding 模型名称 */
  embeddingModel: z.string()
    .default('nomic-embed-text')
    .description('Embedding 模型名称（例如 Ollama: nomic-embed-text）'),

  /** 代码仓库根路径 */
  indexRoot: z.string()
    .default('')
    .description('代码仓库根路径，用于索引时扫描文件'),

  /** 索引的文件后缀 (逗号分隔) */
  indexExtensions: z.string()
    .default('')
    .description('索引的文件后缀（逗号分隔，留空则索引所有支持的扩展名）'),

  /** 启用混合搜索 (BM25 + 向量) */
  hybridMode: z.boolean()
    .default(true)
    .description('启用混合搜索模式（BM25 全文检索 + 向量语义搜索）'),

  /** BM25 关键词融合 RRF 参数 */
  bm25RrfK: z.number()
    .default(60)
    .description('混合检索 RRF 融合参数 k（默认 60）'),

  /** 跳过索引的目录名 (逗号分隔) */
  indexIgnoreDirs: z.string()
    .default('')
    .description('扫描时跳过的目录名（逗号分隔，默认跳过 dist, build, target, __pycache__, vendor 等）'),

  /** Merkle 状态文件路径 */
  merkleFilePath: z.string()
    .default('')
    .description('Merkle 哈希状态文件路径（用于增量索引，留空使用默认位置）'),

  /** 自定义忽略规则 (gitignore 风格) */
  ignorePatterns: z.string()
    .default('')
    .description('自定义 gitignore 风格忽略规则，每行一个模式')
    .role('textarea'),
})

export function apply(ctx: Context, config?: CordisConfig) {
  // ── Settings registration (mirrors web-search-deepseek pattern) ──────
  // `current` is a thunk so tools always read the latest config after a
  // GUI edit without requiring a plugin reload.
  let current: () => CordisConfig = () => config ?? {}

  installSettingsSection(ctx, SETTINGS_NAMESPACE, Config, config ?? {}, {
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      console.log('[dsh-context-milvus] Configuration updated via settings')
    },
  })

  // Resolve initial config for startup services
  const resolved = getConfig(current())
  const embeddingClient = new EmbeddingClient(resolved.embedding)
  const milvus = new MilvusService({
    address: resolved.milvusAddress,
    token: resolved.milvusToken,
    collection: resolved.milvusCollection,
    dim: resolved.milvusDim,
    embeddingClient,
    hybridMode: resolved.hybridMode,
    bm25RrfK: resolved.bm25RrfK,
  })

  const tracker = new HashTracker(resolved.merkleFilePath)

  // Load Merkle state on startup (non-blocking)
  tracker.load().catch(() => {
    // No state file yet — fresh start
  })

  // Try to initialize collection; failure doesn't block tool registration
  milvus.ensureCollection().catch((err: Error) => {
    console.warn(
      `[dsh-context-milvus] 集合初始化失败，将在首次使用工具时重试: ${err.message}`,
    )
  })

  // Register all tools — pass the config thunk so each tool execution
  // picks up the latest settings without restart
  registerTools(ctx, () => getConfig(current()), milvus, tracker)

  console.log(
    `[dsh-context-milvus] 已加载 (${resolved.indexExtensions.length} 种文件类型, ` +
    `hybrid=${resolved.hybridMode})`,
  )
}
