/**
 * Indexing pipeline — orchestrates the full code indexing process.
 *
 * 1. Walk the directory tree and discover files
 * 2. Compute file hashes and compare with Merkle state
 * 3. For changed files: parse → chunk → embed → insert
 * 4. For deleted files: remove from Milvus
 * 5. Update Merkle state
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { HashTracker, type IndexDelta } from './merkle.js'
import { chunkCode } from './chunker.js'
import { EmbeddingClient } from './embedding.js'
import type { MilvusService } from './milvus-service.js'
import { type PluginConfig, DEFAULT_IGNORE_PATTERNS } from './config.js'
import { IgnoreMatcher } from './ignore-matcher.js'
import { ImportResolver } from './import-resolver.js'
import type { CodeChunk, IndexStatus, LargeWorkspaceLimits } from './types.js'
import { consoleLogger, type Logger } from './logger.js'

/** Result of a single indexing run */
export interface IndexResult {
  filesIndexed: number
  chunksIndexed: number
  filesRemoved: number
  chunksRemoved: number
  filesSkipped: number
  durationMs: number
}

/** 超过该可索引文件数即视为大工作区。 */
export const LARGE_WORKSPACE_FILE_LIMIT = 1000
/** 超过该源码文本字节数（UTF-8）即视为大工作区。 */
export const LARGE_WORKSPACE_BYTE_LIMIT = 500 * 1024
/** 每成功处理这么多个文件落盘一次 Merkle 状态。 */
export const DEFAULT_CHECKPOINT_EVERY = 50

/** 一次工作区扫描的结果：文件哈希 + 规模统计。 */
export interface WorkspaceProbe {
  files: Map<string, string>
  fileCount: number
  totalBytes: number
  exceedsLargeWorkspace: boolean
}

/** 纯判定：严格大于任一阈值即超阈。 */
export function exceedsLargeWorkspace(
  fileCount: number,
  totalBytes: number,
  limits?: LargeWorkspaceLimits,
): boolean {
  const fileLimit = limits?.files ?? LARGE_WORKSPACE_FILE_LIMIT
  const byteLimit = limits?.bytes ?? LARGE_WORKSPACE_BYTE_LIMIT
  return fileCount > fileLimit || totalBytes > byteLimit
}

/** Result of a directory walk: file hashes plus the size of the text walked. */
interface WalkResult {
  files: Map<string, string>
  totalBytes: number
}

/**
 * Walk a directory recursively and collect all supported files.
 * Returns a map of absolute file path → file content hash, plus the UTF-8 byte
 * length of every file that was read.
 */
async function walkDirectory(
  rootDir: string,
  extensions: string[],
  ignoreMatcher: IgnoreMatcher,
  progress?: (filePath: string) => void,
): Promise<WalkResult> {
  const extSet = new Set(extensions)
  const files = new Map<string, string>()
  let totalBytes = 0

  async function walk(dir: string): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return // Skip directories we can't read
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry)
      let stats: any
      try {
        stats = await stat(fullPath)
      } catch {
        continue
      }

      // Check ignore patterns
      const relativePath = path.relative(rootDir, fullPath)
      if (ignoreMatcher.ignores(relativePath, stats.isDirectory())) continue

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
            // The content is already in memory for hashing — size comes for free.
            totalBytes += Buffer.byteLength(content, 'utf-8')
          } catch {
            // Skip files we can't read
          }
        }
      }
    }
  }

  await walk(rootDir)
  return { files, totalBytes }
}

/**
 * Find all ignore files (.gitignore, .ignore, .xxxignore) in the codebase root.
 */
async function findIgnoreFiles(codebasePath: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(codebasePath)
  } catch {
    return []
  }

  const ignoreFiles: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.') && entry.endsWith('ignore')) {
      ignoreFiles.push(path.join(codebasePath, entry))
    }
  }
  return ignoreFiles
}

/**
 * Read ignore patterns from a file.
 */
async function readIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Load global ignore file from ~/.context/.contextignore.
 */
async function loadGlobalIgnoreFile(): Promise<string[]> {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    if (!homeDir) return []
    const globalIgnorePath = path.join(homeDir, '.context', '.contextignore')
    return await readIgnoreFile(globalIgnorePath)
  } catch {
    return []
  }
}

/**
 * Scan a workspace and report its size.
 *
 * Shares the ignore-rule construction with runIndex so the standalone CLI's
 * --dry-run numbers match what a real index run would see.
 */
export async function probeWorkspace(
  config: PluginConfig,
  options?: { onFileProgress?: (filePath: string) => void; limits?: LargeWorkspaceLimits },
): Promise<WorkspaceProbe> {
  const ignoreMatcher = new IgnoreMatcher([
    ...DEFAULT_IGNORE_PATTERNS,
    ...config.ignorePatterns,
  ])

  // Load codebase-specific ignore files
  const ignoreFiles = await findIgnoreFiles(config.indexRoot)
  for (const ignoreFile of ignoreFiles) {
    const patterns = await readIgnoreFile(ignoreFile)
    ignoreMatcher.addPatterns(patterns)
  }

  // Load global ignore file
  ignoreMatcher.addPatterns(await loadGlobalIgnoreFile())

  const { files, totalBytes } = await walkDirectory(
    config.indexRoot,
    config.indexExtensions,
    ignoreMatcher,
    options?.onFileProgress,
  )

  const fileCount = files.size
  return {
    files,
    fileCount,
    totalBytes,
    exceedsLargeWorkspace: exceedsLargeWorkspace(fileCount, totalBytes, options?.limits),
  }
}

/**
 * Run the indexing pipeline.
 */
export async function runIndex(
  config: PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  options?: {
    mode?: 'full' | 'incremental'
    progress?: (msg: string) => void
    onFileProgress?: (filePath: string) => void
    importResolver?: ImportResolver  // Optional, for import map building
    logger?: Logger  // Used for progress output when no progress callback is given
  },
): Promise<IndexResult> {
  const mode = options?.mode ?? 'incremental'
  const log = options?.logger ?? consoleLogger
  // An explicit progress callback always wins; otherwise fall back to the
  // injected logger so adapters (e.g. the MCP server) keep stdout clean.
  const progress = options?.progress ?? ((msg: string) => log.info(msg))
  const onFileProgress = options?.onFileProgress

  const startTime = Date.now()

  // 1. Ensure Milvus collection exists
  progress('检查 Milvus 集合...')
  await milvus.ensureCollection()

  // 2. Walk directory — also yields the size stats the large-workspace check needs
  progress('扫描代码仓库...')
  const probe = await probeWorkspace(config, { onFileProgress })
  const currentFiles = probe.files

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
    chunksRemoved = await milvus.deleteByFilePaths(delta.toRemove)
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
        const chunks = await chunkCode(filePath, content, ext, {
          contextLines: config.chunkContextLines,
        })

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

        // Insert into Milvus
        const chunksWithVectors = chunks.map((chunk, i) => ({
          ...chunk,
          vector: vectors[i],
        }))

        // For incremental mode, remove old chunks first
        if (mode === 'incremental') {
          await milvus.deleteByFilePath(filePath)
        }

        const inserted = await milvus.insertChunks(chunksWithVectors)
        tracker.updateRecord(filePath, hash, inserted)

        filesIndexed++
        chunksIndexed += inserted
      } catch (err) {
        failedFiles.push(filePath)
        progress(`  失败: ${path.basename(filePath)} — ${(err as Error).message}`)
      }
    }
  }

  // 6. Build import map for changed files
  if (options?.importResolver && delta.toIndex.length > 0) {
    progress('扫描 import/export 关系...')
    for (const filePath of delta.toIndex) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const ext = path.extname(filePath).toLowerCase()
        await options.importResolver.scanFile(filePath, content, ext)
      } catch {
        // Skip files that fail to parse
      }
    }
  }

  // Remove deleted files from import map
  if (options?.importResolver && delta.toRemove.length > 0) {
    for (const filePath of delta.toRemove) {
      options.importResolver.removeFile(filePath)
    }
  }

  // Save import map
  if (options?.importResolver) {
    await options.importResolver.save()
  }

  // 7. Save Merkle state
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