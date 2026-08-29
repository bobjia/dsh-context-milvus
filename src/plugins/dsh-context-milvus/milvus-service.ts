/**
 * Milvus service — client wrapper for collection management, search, and indexing.
 *
 * Provides vector search and chunk insert/delete operations
 * for the indexing pipeline using the @zilliz/milvus2-sdk-node.
 */

import { MilvusClient, DataType, MetricType, ErrorCode } from '@zilliz/milvus2-sdk-node'
import type { SearchResultData, SearchSimpleReq } from '@zilliz/milvus2-sdk-node'
import type { SearchResult, CodeChunk } from './types.js'
import { EmbeddingClient } from './embedding.js'

export class MilvusService {
  private client: MilvusClient | null = null
  private collectionReady = false
  private initPromise: Promise<void> | null = null
  private readonly address: string
  private readonly token: string | undefined
  private readonly collection: string
  private readonly dim: number
  private readonly embeddingClient: EmbeddingClient

  constructor(config: {
    address: string
    token: string | undefined
    collection: string
    dim: number
    embeddingClient: EmbeddingClient
  }) {
    this.address = config.address
    this.token = config.token
    this.collection = config.collection
    this.dim = config.dim
    this.embeddingClient = config.embeddingClient
  }

  // ── Client lazy init ──────────────────────────────────────────────────

  private getClient(): MilvusClient {
    if (!this.client) {
      this.client = new MilvusClient({
        address: this.address,
        ...(this.token ? { token: this.token } : {}),
      })
    }
    return this.client
  }

  // ── Collection initialization ─────────────────────────────────────────

  async ensureCollection(): Promise<void> {
    if (this.collectionReady) return
    if (this.initPromise) return this.initPromise

    this.initPromise = this.initCollection()
    try {
      await this.initPromise
      this.collectionReady = true
    } finally {
      this.initPromise = null
    }
  }

  private async initCollection(): Promise<void> {
    const client = this.getClient()
    const { collection, dim } = this

    // Wait for connection to be ready
    await client.connectPromise

    // Check if collection already exists
    const hasRes = await client.hasCollection({ collection_name: collection })
    if (hasRes.value) return

    // Create collection with schema
    await client.createCollection({
      collection_name: collection,
      fields: [
        {
          name: 'id',
          data_type: DataType.Int64,
          is_primary_key: true,
          autoID: true,
        },
        {
          name: 'vector',
          data_type: DataType.FloatVector,
          dim,
        },
        {
          name: 'file_path',
          data_type: DataType.VarChar,
          max_length: 1024,
        },
        {
          name: 'code_content',
          data_type: DataType.VarChar,
          max_length: 65535,
        },
        {
          name: 'start_line',
          data_type: DataType.Int32,
        },
        {
          name: 'end_line',
          data_type: DataType.Int32,
        },
        {
          name: 'language',
          data_type: DataType.VarChar,
          max_length: 64,
        },
        {
          name: 'chunk_type',
          data_type: DataType.VarChar,
          max_length: 64,
        },
        {
          name: 'name',
          data_type: DataType.VarChar,
          max_length: 256,
        },
      ],
      enable_dynamic_field: true,
    } as any)

    // Create index on vector field
    await client.createIndex({
      collection_name: collection,
      field_name: 'vector',
      metric_type: MetricType.COSINE,
      index_name: 'idx_vector',
    } as any)

    // Load collection for search
    await client.loadCollectionSync({
      collection_name: collection,
    })
  }

  // ── Text search (via vector embedding) ────────────────────────────────

  /**
   * Execute a semantic text search.
   * Queries are embedded locally, then vector search is performed via the SDK.
   *
   * @param query - Natural language query text
   * @param topK - Number of results to return
   * @param pathPrefix - Optional path prefix filter (e.g., "/workspace/project")
   *                     Only results with file_path starting with this prefix will be returned.
   */
  async search(query: string, topK: number, pathPrefix?: string): Promise<SearchResult[]> {
    const client = this.getClient()
    const { collection } = this

    // Embed the query text using the configured embedding API
    const vectors = await this.embeddingClient.embed([query])
    if (vectors.length === 0) return []
    const vector = vectors[0]

    const searchParams: SearchSimpleReq = {
      collection_name: collection,
      vector: vector,
      limit: topK,
      output_fields: [
        'file_path', 'code_content', 'start_line', 'end_line',
        'language', 'chunk_type', 'name',
      ],
    }

    // If a path prefix is provided, filter results to that workspace
    if (pathPrefix) {
      searchParams.filter = `file_path like "${pathPrefix}%"`
    }

    const response = await client.search(searchParams)

    // Milvus returns results as SearchResultData[] when nq === 1
    const results = (response.results ?? []) as SearchResultData[]

    return results.map((item: SearchResultData) => ({
      filePath: item.file_path ?? '',
      content: item.code_content ?? '',
      score: item.score,
      language: item.language ?? '',
      startLine: Number(item.start_line ?? 0),
      endLine: Number(item.end_line ?? 0),
      name: item.name ?? '',
      chunkType: item.chunk_type ?? '',
    }))
  }

  // ── Bulk insert (for indexing) ────────────────────────────────────────

  /**
   * Insert code chunks with their embedding vectors into the collection.
   *
   * @param chunks - Array of code chunks with pre-computed embedding vectors
   */
  async insertChunks(
    chunks: Array<CodeChunk & { vector: number[] }>,
  ): Promise<number> {
    if (chunks.length === 0) return 0

    const client = this.getClient()
    const { collection } = this

    // Insert in batches of 100
    let totalInserted = 0
    const batchSize = 100

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize)
      const response = await client.insert({
        collection_name: collection,
        data: batch.map((chunk) => ({
          vector: chunk.vector,
          file_path: chunk.filePath,
          code_content: chunk.content,
          start_line: chunk.startLine,
          end_line: chunk.endLine,
          language: chunk.language,
          chunk_type: chunk.chunkType,
          name: chunk.name,
        })),
      })
      totalInserted += Number(response.insert_cnt ?? 0)
    }

    return totalInserted
  }

  // ── Delete by file path (for incremental index) ───────────────────────

  /**
   * Delete all chunks associated with a given file path.
   *
   * @param filePath - The file path to remove from the index
   * @returns Number of deleted chunks
   */
  async deleteByFilePath(filePath: string): Promise<number> {
    const client = this.getClient()
    const { collection } = this

    const response = await client.delete({
      collection_name: collection,
      filter: `file_path == "${filePath}"`,
    })

    return Number(response.delete_cnt ?? 0)
  }

  /**
   * Delete all chunks for multiple file paths.
   *
   * @param filePaths - Array of file paths to remove
   * @returns Total number of deleted chunks
   */
  async deleteByFilePaths(filePaths: string[]): Promise<number> {
    if (filePaths.length === 0) return 0

    let totalDeleted = 0
    for (const filePath of filePaths) {
      totalDeleted += await this.deleteByFilePath(filePath)
    }
    return totalDeleted
  }
}