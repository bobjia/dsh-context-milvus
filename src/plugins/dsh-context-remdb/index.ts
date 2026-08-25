/**
 * dsh-context-remdb — DSH plugin entry point
 *
 * A complete index ↔ search plugin for semantic code search via RemDB.
 * - search_code: 语义搜索代码
 * - index_code:  索引代码仓库
 * - index_status: 查看索引状态
 *
 * Configuration (优先顺序: Cordis Config > 环境变量 > 默认值):
 *
 *   Cordis Config (通过 cordis.yml / DSH GUI 设置):
 *     remdbEndpoint, remdbToken, remdbCollection, remdbDim,
 *     embeddingEndpoint, embeddingApiKey, embeddingModel,
 *     indexRoot, indexExtensions, hybridMode, merkleFilePath
 *
 *   环境变量 (fallback):
 *     REMDB_ENDPOINT, REMDB_TOKEN, REMDB_COLLECTION, REMDB_EMBEDDING_DIM,
 *     EMBEDDING_ENDPOINT, EMBEDDING_API_KEY, EMBEDDING_MODEL,
 *     INDEX_ROOT, INDEX_EXTENSIONS, HYBRID_MODE, MERKLE_FILE_PATH
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import { getConfig, type CordisConfig } from './config.js'
import { RemDbService } from './remdb-service.js'
import { HashTracker } from './merkle.js'
import { EmbeddingClient } from './embedding.js'
import { registerTools } from './tools.js'

export const name = 'dsh-context-remdb'
export const inject = ['tools']

/**
 * Config schema for dsh-context-remdb.
 *
 * This schema is used by:
 * - Cordis loader for config validation before the plugin starts
 * - DSH Web GUI (Settings → Plugins) for auto-generated configuration UI
 *
 * Fields with `.role('secret')` are rendered as password inputs in the GUI.
 * Fields with `.description(...)` show tooltips/labels in the GUI.
 */
export const Config = z.object({
  /** RemDB 服务地址 */
  remdbEndpoint: z.string()
    .default('http://localhost:19530')
    .description('RemDB 服务地址，例如 http://localhost:19530'),

  /** RemDB 鉴权 Token (可选) */
  remdbToken: z.string()
    .default('')
    .description('RemDB 鉴权 Token（如不需要可留空）')
    .role('secret'),

  /** RemDB 集合名称 */
  remdbCollection: z.string()
    .default('code_embeddings')
    .description('RemDB 集合名称，用于存储代码向量'),

  /** 向量维度 */
  remdbDim: z.number()
    .default(768)
    .description('Embedding 向量维度（需与模型匹配）'),

  /** Embedding API 地址 */
  embeddingEndpoint: z.string()
    .default('http://localhost:19530/v2/vectordb/embedding')
    .description('Embedding API 地址'),

  /** Embedding API 密钥 (可选) */
  embeddingApiKey: z.string()
    .default('')
    .description('Embedding API 密钥（如不需要可留空）')
    .role('secret'),

  /** Embedding 模型名称 */
  embeddingModel: z.string()
    .default('default')
    .description('Embedding 模型名称（需与 API 兼容）'),

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

  /** Merkle 状态文件路径 */
  merkleFilePath: z.string()
    .default('')
    .description('Merkle 哈希状态文件路径（用于增量索引，留空使用默认位置）'),
})

export function apply(ctx: Context, config?: CordisConfig) {
  const resolved = getConfig(config ?? {})
  const embeddingClient = new EmbeddingClient(resolved.embedding)
  const remdb = new RemDbService({
    endpoint: resolved.remdbEndpoint,
    token: resolved.remdbToken,
    collection: resolved.remdbCollection,
    dim: resolved.remdbDim,
    embeddingClient,
  })

  const tracker = new HashTracker(resolved.merkleFilePath)

  // Load Merkle state on startup (non-blocking)
  tracker.load().catch(() => {
    // No state file yet — fresh start
  })

  // Try to initialize collection; failure doesn't block tool registration
  remdb.ensureCollection().catch((err: Error) => {
    console.warn(
      `[dsh-context-remdb] 集合初始化失败，将在首次使用工具时重试: ${err.message}`,
    )
  })

  // Register all tools
  registerTools(ctx, resolved, remdb, tracker)

  console.log(
    `[dsh-context-remdb] 已加载 (${resolved.indexExtensions.length} 种文件类型, ` +
    `hybrid=${resolved.hybridMode})`,
  )
}