// src/plugins/dsh-context-milvus/adr-indexer.ts
import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import { HashTracker } from './merkle.js'
import { EmbeddingClient } from './embedding.js'
import { chunkAdrFile } from './adr-chunker.js'
import { AdrAnchorIndex } from './adr-anchor-index.js'
import type { MilvusService } from './milvus-service.js'
import type { PluginConfig } from './config.js'
import type { AdrIndexStatus } from './types.js'
import type { AdrService } from './adr-service.js'

const ADR_FILE_RE = /^ADR-\d{4}-.+\.md$/
const SPEC_FILE_RE = /^\d{4}-\d{2}-\d{2}-.+design\.md$/
const PLAN_FILE_RE = /^\d{4}-\d{2}-\d{2}-(?:(?!.*design\.md$).)+\.md$/

/** A single root directory to scan */
export interface ScanRoot {
  path: string
  fileRe: RegExp
  label: string
}

/** Result of a single ADR indexing run */
export interface AdrIndexResult {
  filesIndexed: number
  chunksIndexed: number
  filesRemoved: number
  chunksRemoved: number
  filesSkipped: number
  durationMs: number
}

/**
 * Scan a single root directory, returning a map of filePath → content hash.
 * Missing or unreadable directories are skipped silently (empty map).
 */
async function scanDirectory(root: ScanRoot): Promise<Map<string, string>> {
  let files: string[]
  try {
    files = (await readdir(root.path))
      .filter(f => root.fileRe.test(f))
      .map(f => path.join(root.path, f))
  } catch {
    return new Map()
  }

  const currentFiles = new Map<string, string>()
  for (const filePath of files) {
    const content = await readFile(filePath, 'utf-8')
    const hash = HashTracker.hashContent(content)
    currentFiles.set(filePath, hash)
  }
  return currentFiles
}

/**
 * Run the ADR indexing pipeline.
 *
 * 1. Skip if ADR indexing is disabled
 * 2. Ensure the Milvus ADR collection exists
 * 3. Scan the ADR, spec, and plan directories and hash matching files
 * 4. Compute delta via Merkle tracker
 * 5. Remove deleted files (from Milvus + anchor index)
 * 6. Chunk → embed → insert changed files; update anchor index
 * 7. Persist Merkle + anchor index state
 */
export async function runAdrIndex(
  config: PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  anchorIndex: AdrAnchorIndex,
  options?: { mode?: 'full' | 'incremental'; progress?: (msg: string) => void },
): Promise<AdrIndexResult> {
  const mode = options?.mode ?? 'incremental'
  const progress = options?.progress ?? (() => {})
  const startTime = Date.now()

  if (!config.adrEnabled) {
    return { filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0, filesSkipped: 0, durationMs: 0 }
  }

  progress('检查 Milvus ADR 集合...')
  await milvus.ensureAdrCollection()

  // Build scan roots from config
  const scanRoots: ScanRoot[] = [
    { path: config.adrRoot, fileRe: ADR_FILE_RE, label: 'ADR' },
    { path: config.specRoot, fileRe: SPEC_FILE_RE, label: 'spec' },
    { path: config.planRoot, fileRe: PLAN_FILE_RE, label: 'plan' },
  ]

  // Scan all roots and merge into a single file → hash map
  progress('扫描目录...')
  const currentFiles = new Map<string, string>()
  for (const root of scanRoots) {
    const files = await scanDirectory(root)
    for (const [filePath, hash] of files) {
      currentFiles.set(filePath, hash)
    }
  }

  const allFiles = Array.from(currentFiles.keys())

  // Compute delta
  let delta: { toIndex: string[]; toRemove: string[]; unchanged: string[] }
  if (mode === 'full') {
    delta = { toIndex: allFiles, toRemove: [], unchanged: [] }
  } else {
    delta = tracker.computeDelta(currentFiles)
  }

  // Remove deleted files
  let chunksRemoved = 0
  if (delta.toRemove.length > 0) {
    progress(`移除已删除文件: ${delta.toRemove.length} 个...`)
    for (const filePath of delta.toRemove) {
      chunksRemoved += await milvus.deleteAdrByFilePath(filePath)
    }
    tracker.removeRecords(delta.toRemove)
    // Remove from anchor index
    for (const filePath of delta.toRemove) {
      const basename = path.basename(filePath)
      const adrId = basename.replace(/\.md$/, '')
      anchorIndex.removeAdr(adrId)
    }
  }

  // Index changed files
  const embeddingClient = new EmbeddingClient(config.embedding)
  let filesIndexed = 0
  let chunksIndexed = 0

  if (delta.toIndex.length > 0) {
    progress(`索引 ${delta.toIndex.length} 个文件...`)
    for (const filePath of delta.toIndex) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const hash = currentFiles.get(filePath) ?? HashTracker.hashContent(content)

        const chunks = await chunkAdrFile(filePath, content)
        if (chunks.length === 0) {
          tracker.updateRecord(filePath, hash, 0)
          continue
        }

        // Get embeddings
        const texts = chunks.map(c => c.content)
        const vectors = await embeddingClient.embed(texts)
        if (vectors.length !== chunks.length) {
          throw new Error(`Embedding mismatch: ${vectors.length} vectors for ${chunks.length} chunks`)
        }

        // Insert with vectors
        const chunksWithVectors = chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }))
        if (mode === 'incremental') {
          await milvus.deleteAdrByFilePath(filePath)
        }
        const inserted = await milvus.insertAdrChunks(chunksWithVectors)

        // Update anchor index
        const adrId = path.basename(filePath).replace(/\.md$/, '')
        const anchorFiles = chunks.length > 0 ? chunks[0].codeAnchors : []
        anchorIndex.setAdr(adrId, anchorFiles)

        tracker.updateRecord(filePath, hash, inserted)
        filesIndexed++
        chunksIndexed += inserted
      } catch (err) {
        progress(`  失败: ${path.basename(filePath)} — ${(err as Error).message}`)
      }
    }
  }

  // Save state
  await tracker.save()
  await anchorIndex.save()

  return {
    filesIndexed,
    chunksIndexed,
    filesRemoved: delta.toRemove.length,
    chunksRemoved,
    filesSkipped: delta.unchanged.length,
    durationMs: Date.now() - startTime,
  }
}

/**
 * Get current ADR index status.
 *
 * totalAdrs / totalChunks come from the Merkle tracker; activeAdrs is
 * derived by scanning the ADR directory through AdrService.
 */
export async function getAdrIndexStatus(
  tracker: HashTracker,
  adrService: AdrService,
): Promise<AdrIndexStatus> {
  const stats = tracker.getStats()
  const lastIndexedTs = tracker.getLastIndexedTimestamp()

  // Count active ADRs by scanning the ADR directory
  let activeAdrs = 0
  try {
    const all = await adrService.listAdrs({ status: 'all', limit: 10000 })
    activeAdrs = all.filter(a => a.status === 'active').length
  } catch {
    activeAdrs = 0
  }

  return {
    totalAdrs: stats.totalFiles,
    totalChunks: stats.totalChunks,
    lastIndexed: lastIndexedTs ? new Date(lastIndexedTs).toISOString() : '',
    activeAdrs,
  }
}
