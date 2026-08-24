/**
 * RemDB service — client wrapper for collection management, search, and indexing.
 *
 * Provides text search (server-side embedding) and chunk insert/delete operations
 * for the indexing pipeline.
 */

import { RemDbClient } from 'remdb-sdk-node'
import type { RemDbResponse, SearchResultItem } from 'remdb-sdk-node'
import type { SearchResult, CodeChunk } from './types.js'

export class RemDbService {
  private client: RemDbClient | null = null
  private collectionReady = false
  private initPromise: Promise<void> | null = null
  private readonly endpoint: string
  private readonly token: string | undefined
  private readonly collection: string
  private readonly dim: number

  constructor(config: {
    endpoint: string
    token: string | undefined
    collection: string
    dim: number
  }) {
    this.endpoint = config.endpoint
    this.token = config.token
    this.collection = config.collection
    this.dim = config.dim
  }

  // ── Client lazy init ──────────────────────────────────────────────────

  private getClient(): RemDbClient {
    if (!this.client) {
      this.client = new RemDbClient({
        endpoint: this.endpoint,
        token: this.token,
        timeout: 30_000,
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

    const hasRes = await client.hasCollection({ collectionName: collection })
    if (hasRes.data?.has) return

    await client.createCollection({
      collectionName: collection,
      schema: {
        autoId: true,
        fields: [
          { name: 'id', type: 'Int64', isPrimary: true, autoId: true },
          { name: 'vector', type: 'FloatVector', params: { dim } },
          { name: 'file_path', type: 'VarChar', params: { max_length: 1024 } },
          { name: 'code_content', type: 'Text' },
          { name: 'start_line', type: 'Int32' },
          { name: 'end_line', type: 'Int32' },
          { name: 'language', type: 'VarChar', params: { max_length: 64 } },
          { name: 'chunk_type', type: 'VarChar', params: { max_length: 64 } },
          { name: 'name', type: 'VarChar', params: { max_length: 256 } },
        ],
      },
      indexParams: [
        { fieldName: 'vector', indexName: 'idx_vector', metricType: 'COSINE' },
      ],
    })
  }

  // ── Text search ───────────────────────────────────────────────────────

  /**
   * Execute a semantic text search.
   * RemDB server handles text-to-vector embedding internally.
   */
  async search(query: string, topK: number): Promise<SearchResult[]> {
    const client = this.getClient()
    const { collection } = this

    const response = await client.POST<RemDbResponse<SearchResultItem[]>>(
      '/v2/vectordb/entities/search',
      {
        collectionName: collection,
        text: query,
        limit: topK,
        outputFields: [
          'file_path', 'code_content', 'start_line', 'end_line',
          'language', 'chunk_type', 'name',
        ],
      },
    )

    return (response.data ?? []).map((item) => ({
      filePath: item.entity.file_path ?? '',
      content: item.entity.code_content ?? '',
      score: 1 - item.distance,
      language: item.entity.language ?? '',
      startLine: item.entity.start_line ?? 0,
      endLine: item.entity.end_line ?? 0,
      name: item.entity.name ?? '',
      chunkType: item.entity.chunk_type ?? '',
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
        collectionName: collection,
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
      totalInserted += response.data?.insertCount ?? 0
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
      collectionName: collection,
      filter: `file_path == "${filePath}"`,
    })

    return response.data?.deleteCount ?? 0
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