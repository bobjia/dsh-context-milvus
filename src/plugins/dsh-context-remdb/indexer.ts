/**
 * Indexing pipeline — orchestrates the full code indexing process.
 *
 * 1. Walk the directory tree and discover files
 * 2. Compute file hashes and compare with Merkle state
 * 3. For changed files: parse → chunk → embed → insert
 * 4. For deleted files: remove from RemDB
 * 5. Update Merkle state
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { HashTracker, type IndexDelta } from './merkle.js'
import { chunkCode } from './chunker.js'
import { EmbeddingClient } from './embedding.js'
import type { RemDbService } from './remdb-service.js'
import { type PluginConfig } from './config.js'
import type { CodeChunk, IndexStatus } from './types.js'

/** Result of a single indexing run */
export interface IndexResult {
  filesIndexed: number
  chunksIndexed: number
  filesRemoved: number
  chunksRemoved: number
  filesSkipped: number
  durationMs: number
}

/**
 * Walk a directory recursively and collect all supported files.
 * Returns a map of absolute file path → file content hash.
 */
async function walkDirectory(
  rootDir: string,
  extensions: string[],
  progress?: (filePath: string) => void,
): Promise<Map<string, string>> {
  const extSet = new Set(extensions)
  const files = new Map<string, string>()

  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return // Skip directories we can't read
    }

    for (const entry of entries) {
      // Skip hidden directories and node_modules
      if (entry === '.git' || entry === 'node_modules' || entry === '.hg' || entry === '.svn') continue
      if (entry.startsWith('.') && entry !== '.') continue

      const fullPath = path.join(dir, entry)
      let stats: any
      try {
        stats = await stat(fullPath)
      } catch {
        continue
      }

      if (stats.isDirectory()) {
        await walk(fullPath)
      } else if (stats.isFile()) {
        const ext = path.extname(fullPath).toLowerCase()
        if (extSet.has(ext)) {
          progress?.(fullPath)
          // Compute hash from file content
          try {
            const content = await readFile(fullPath, 'utf-8')
            const hash = HashTracker.hashContent(content)
            files.set(fullPath, hash)
          } catch {
            // Skip files we can't read
          }
        }
      }
    }
  }

  await walk(rootDir)
  return files
}

/**
 * Run the indexing pipeline.
 */
export async function runIndex(
  config: PluginConfig,
  remdb: RemDbService,
  tracker: HashTracker,
  options?: {
    mode?: 'full' | 'incremental'
    progress?: (msg: string) => void
    onFileProgress?: (filePath: string) => void
  },
): Promise<IndexResult> {
  const mode = options?.mode ?? 'incremental'
  const progress = options?.progress ?? (() => {})
  const onFileProgress = options?.onFileProgress

  const startTime = Date.now()

  // 1. Ensure RemDB collection exists
  progress('检查 RemDB 集合...')
  await remdb.ensureCollection()

  // 2. Walk directory
  progress('扫描代码仓库...')
  const currentFiles = await walkDirectory(
    config.indexRoot,
    config.indexExtensions,
    onFileProgress,
  )

  // 3. Compute delta
  let delta: IndexDelta
  if (mode === 'full') {
    // Full mode: index everything, remove nothing (since we'll re-insert)
    delta = {
      toIndex: Array.from(currentFiles.keys()),
      toRemove: [],
      unchanged: [],
    }
  } else {
    progress('检测文件变更...')
    delta = tracker.computeDelta(currentFiles)
  }

  // 4. Remove deleted files from RemDB
  let chunksRemoved = 0
  if (delta.toRemove.length > 0) {
    progress(`移除已删除文件: ${delta.toRemove.length} 个...`)
    chunksRemoved = await remdb.deleteByFilePaths(delta.toRemove)
    tracker.removeRecords(delta.toRemove)
  }

  // 5. Index changed files
  const embeddingClient = new EmbeddingClient(config.embedding)
  let filesIndexed = 0
  let chunksIndexed = 0
  const failedFiles: string[] = []

  if (delta.toIndex.length > 0) {
    progress(`索引 ${delta.toIndex.length} 个文件...`)

    for (const filePath of delta.toIndex) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const ext = path.extname(filePath).toLowerCase()
        const hash = currentFiles.get(filePath) ?? HashTracker.hashContent(content)

        // Parse and chunk
        const chunks = chunkCode(filePath, content, ext)

        if (chunks.length === 0) {
          // No chunkable structures found — still record the hash to avoid re-scanning
          tracker.updateRecord(filePath, hash, 0)
          continue
        }

        // Generate embeddings in batches
        const texts = chunks.map((c) => c.content)
        const vectors = await embeddingClient.embed(texts)

        if (vectors.length !== chunks.length) {
          throw new Error(
            `Embedding mismatch: got ${vectors.length} vectors for ${chunks.length} chunks`,
          )
        }

        // Insert into RemDB
        const chunksWithVectors = chunks.map((chunk, i) => ({
          ...chunk,
          vector: vectors[i],
        }))

        // For incremental mode, remove old chunks first
        if (mode === 'incremental') {
          await remdb.deleteByFilePath(filePath)
        }

        const inserted = await remdb.insertChunks(chunksWithVectors)
        tracker.updateRecord(filePath, hash, inserted)

        filesIndexed++
        chunksIndexed += inserted
      } catch (err) {
        failedFiles.push(filePath)
        progress(`  失败: ${path.basename(filePath)} — ${(err as Error).message}`)
      }
    }
  }

  // 6. Save Merkle state
  await tracker.save()

  const durationMs = Date.now() - startTime

  return {
    filesIndexed,
    chunksIndexed,
    filesRemoved: delta.toRemove.length,
    chunksRemoved,
    filesSkipped: delta.unchanged.length,
    durationMs,
  }
}

/**
 * Get current index status.
 */
export async function getIndexStatus(
  config: PluginConfig,
  tracker: HashTracker,
): Promise<IndexStatus> {
  const stats = tracker.getStats()
  const lastIndexedTs = tracker.getLastIndexedTimestamp()
  const lastIndexed = lastIndexedTs ? new Date(lastIndexedTs).toISOString() : undefined

  return {
    totalFiles: stats.totalFiles,
    totalChunks: stats.totalChunks,
    lastIndexed,
    indexedExtensions: config.indexExtensions,
  }
}