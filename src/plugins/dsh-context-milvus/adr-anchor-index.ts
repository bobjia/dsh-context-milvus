// src/plugins/dsh-context-milvus/adr-anchor-index.ts
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { AnchorIndexStats } from './types.js'

/** Reverse index: file path → ADR ids, persisted as JSON sidecar */
export class AdrAnchorIndex {
  /** filePath → ADR ids */
  private fileToAdrs = new Map<string, string[]>()
  /** adrId → file paths */
  private adrToFiles = new Map<string, string[]>()
  private dirty = false

  constructor(private readonly filePath: string) {}

  /** Load index from disk */
  async load(): Promise<boolean> {
    if (!existsSync(this.filePath)) return false
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf-8'))
      this.fileToAdrs = new Map(Object.entries(data.fileToAdrs ?? {}))
      this.adrToFiles = new Map(Object.entries(data.adrToFiles ?? {}))
      this.dirty = false
      return true
    } catch {
      return false
    }
  }

  /** Save index to disk */
  async save(): Promise<void> {
    if (!this.dirty) return
    const data = {
      fileToAdrs: Object.fromEntries(this.fileToAdrs),
      adrToFiles: Object.fromEntries(this.adrToFiles),
    }
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
    this.dirty = false
  }

  /** Get all ADR ids that anchor a given file */
  getAdrsForFile(filePath: string): string[] {
    // Normalize: remove leading ./ and resolve relative paths
    const normalized = normalizePath(filePath)
    // Try exact, then try each key with normalized comparison
    for (const [key, adrs] of this.fileToAdrs) {
      if (filePath.endsWith(key) || key.endsWith(filePath) || normalized === normalizePath(key)) {
        return [...adrs]
      }
    }
    const direct = this.fileToAdrs.get(filePath)
    return direct ? [...direct] : []
  }

  /** Get all file paths anchored by a given ADR */
  getFilesForAdr(adrId: string): string[] {
    return [...(this.adrToFiles.get(adrId) ?? [])]
  }

  /** Set/update anchor mappings for one ADR */
  setAdr(adrId: string, files: string[]): void {
    // Remove old mappings for this ADR
    this.removeAdr(adrId)

    // Set new mappings
    this.adrToFiles.set(adrId, [...files])
    for (const file of files) {
      const existing = this.fileToAdrs.get(file) ?? []
      existing.push(adrId)
      this.fileToAdrs.set(file, existing)
    }
    this.dirty = true
  }

  /** Remove all anchor mappings for one ADR */
  removeAdr(adrId: string): void {
    const oldFiles = this.adrToFiles.get(adrId)
    if (oldFiles) {
      for (const file of oldFiles) {
        const adrs = this.fileToAdrs.get(file)
        if (adrs) {
          const filtered = adrs.filter(id => id !== adrId)
          if (filtered.length > 0) {
            this.fileToAdrs.set(file, filtered)
          } else {
            this.fileToAdrs.delete(file)
          }
        }
      }
    }
    this.adrToFiles.delete(adrId)
    this.dirty = true
  }

  /** Get all file → ADR mappings */
  getAll(): Map<string, string[]> {
    return new Map(this.fileToAdrs)
  }

  /** Get index statistics */
  getStats(): AnchorIndexStats {
    let anchorCount = 0
    for (const files of this.adrToFiles.values()) {
      anchorCount += files.length
    }
    return {
      adrCount: this.adrToFiles.size,
      anchorCount,
    }
  }
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/')
}