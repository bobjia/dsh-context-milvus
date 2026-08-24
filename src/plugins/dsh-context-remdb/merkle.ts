/**
 * Merkle-style file hash tracking for incremental indexing.
 *
 * Stores file hashes in a local JSON file. On each index run, compares
 * current file hashes with stored hashes to determine which files need
 * re-indexing.
 */

import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import type { HashRecord, MerkleState } from './types.js'

/** Files that need indexing: new, modified, or unchanged */
export interface IndexDelta {
  /** Files that are new or have changed content */
  toIndex: string[]
  /** Files that were deleted since last index */
  toRemove: string[]
  /** Files that are unchanged (skip) */
  unchanged: string[]
}

const CURRENT_VERSION = 1

export class HashTracker {
  private state: MerkleState
  private dirty = false
  private readonly filePath: string

  constructor(filePath: string) {
    this.filePath = filePath
    this.state = { version: CURRENT_VERSION, records: [] }
  }

  /** Load state from disk. Returns true if state was loaded. */
  async load(): Promise<boolean> {
    try {
      const data = await readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(data) as MerkleState
      if (parsed.version === CURRENT_VERSION && Array.isArray(parsed.records)) {
        this.state = parsed
        return true
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
    return false
  }

  /** Save state to disk if dirty */
  async save(): Promise<void> {
    if (!this.dirty) return
    const dir = path.dirname(this.filePath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
    await writeFile(this.filePath, JSON.stringify(this.state, null, 2), 'utf-8')
    this.dirty = false
  }

  /** Compute SHA-256 hash of file content */
  static hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex')
  }

  /** Get stored hash for a file path, or undefined if not tracked */
  getStoredHash(filePath: string): string | undefined {
    return this.state.records.find((r) => r.filePath === filePath)?.hash
  }

  /**
   * Compute the delta between current file hashes and stored state.
   *
   * @param files - Map of file path → content hash for current filesystem state
   * @returns Delta describing what to index, remove, and skip
   */
  computeDelta(files: Map<string, string>): IndexDelta {
    const toIndex: string[] = []
    const toRemove: string[] = []
    const unchanged: string[] = []
    const processed = new Set<string>()

    for (const [filePath, hash] of files) {
      processed.add(filePath)
      const stored = this.getStoredHash(filePath)
      if (stored === undefined) {
        toIndex.push(filePath) // New file
      } else if (stored !== hash) {
        toIndex.push(filePath) // Modified file
      } else {
        unchanged.push(filePath) // Unchanged
      }
    }

    // Find deleted files
    for (const record of this.state.records) {
      if (!processed.has(record.filePath)) {
        toRemove.push(record.filePath)
      }
    }

    return { toIndex, toRemove, unchanged }
  }

  /**
   * Update stored records after indexing.
   *
   * @param filePath - Indexed file path
   * @param hash - File content hash
   * @param chunkCount - Number of chunks indexed
   */
  updateRecord(filePath: string, hash: string, chunkCount: number): void {
    const existing = this.state.records.findIndex((r) => r.filePath === filePath)
    const record: HashRecord = {
      filePath,
      hash,
      lastIndexed: Date.now(),
      chunkCount,
    }
    if (existing >= 0) {
      this.state.records[existing] = record
    } else {
      this.state.records.push(record)
    }
    this.dirty = true
  }

  /** Remove records for deleted files */
  removeRecords(filePaths: string[]): void {
    const toRemove = new Set(filePaths)
    this.state.records = this.state.records.filter(
      (r) => !toRemove.has(r.filePath),
    )
    if (toRemove.size > 0) this.dirty = true
  }

  /** Get summary statistics */
  getStats(): { totalFiles: number; totalChunks: number } {
    const totalFiles = this.state.records.length
    const totalChunks = this.state.records.reduce(
      (sum, r) => sum + r.chunkCount,
      0,
    )
    return { totalFiles, totalChunks }
  }
}