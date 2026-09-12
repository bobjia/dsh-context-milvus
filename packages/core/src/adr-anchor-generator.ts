// src/plugins/dsh-context-milvus/adr-anchor-generator.ts

import { readFile, writeFile, rename, readdir } from 'node:fs/promises'
import { dump as yamlDump } from 'js-yaml'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { parseFrontmatter } from './adr-frontmatter.js'
import type { AdrFrontmatter, AdrCodeAnchor } from './types.js'

export interface DetectedRef {
  file: string
  symbols: string[]
  lines: [number, number]
}

export interface GenerateResult {
  adrId: string
  detectedRefs: DetectedRef[]
  generated: boolean
}

// --- Regex patterns ---

const FILE_ANNOTATION_RE = /@file:([^\s\n.,:;)\]>]+(?:\.[a-z]+)*)/g
const SYMBOL_ANNOTATION_RE = /@symbol:([^\s\n.,:;)\]>]+)/g

const PATH_PREFIXES = ['src/', 'lib/', 'packages/', 'app/', 'include/', 'test/']
const PATH_RE = /(?<=^|\s|["'`(])(src|lib|packages|app|include|test)\/[^\s:;,).]+(?:\.[a-z]+)*/g

const SYMBOL_RE = /`([a-zA-Z_$][a-zA-Z0-9_$]*)`/g

/**
 * Scan a directory for markdown files without YAML frontmatter.
 * Returns absolute file paths that need frontmatter generation.
 */
export async function findCandidateFiles(
  rootDir: string,
  fileRe: RegExp,
): Promise<string[]> {
  const results: string[] = []

  async function walk(dir: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      // Directory doesn't exist or can't be read — skip silently
      return
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(fullPath)
      } else if (entry.isFile() && entry.name.match(fileRe)) {
        try {
          const content = await readFile(fullPath, 'utf-8')
          if (!parseFrontmatter(content)) {
            results.push(fullPath)
          }
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  await walk(rootDir)
  return results
}

/**
 * Detect code references in a spec/plan document.
 * Three strategies (cumulative):
 * 1. @file: and @symbol: annotations
 * 2. src/ lib/ packages/ path patterns
 * 3. Backtick-quoted symbols with nearby file paths
 */
export function detectCodeReferences(
  content: string,
  codebaseRoot: string,
): DetectedRef[] {
  const lines = content.split('\n')
  const refMap = new Map<string, DetectedRef>()

  /**
   * Add or merge a DetectedRef for the given file.
   * If the file already exists in the map, its symbols are merged
   * and the line range is expanded to cover both entries.
   */
  function addRef(file: string, symbol: string | null, line: number): void {
    // Resolve relative to codebase root
    const absFile = path.resolve(codebaseRoot, file)
    if (!existsSync(absFile)) return

    const existing = refMap.get(absFile)
    if (existing) {
      // Merge symbols
      if (symbol !== null && !existing.symbols.includes(symbol)) {
        existing.symbols.push(symbol)
      }
      // Expand line range
      existing.lines = [
        Math.min(existing.lines[0], line),
        Math.max(existing.lines[1], line),
      ] as [number, number]
    } else {
      refMap.set(absFile, {
        file: absFile,
        symbols: symbol !== null ? [symbol] : [],
        lines: [line, line] as [number, number],
      })
    }
  }

  /**
   * Get the line number (1-based) for a character position in the content.
   */
  function getLineNumber(pos: number): number {
    return content.slice(0, pos).split('\n').length
  }

  // ===== Strategy 1: @file: and @symbol: annotations =====

  // Find all @file: annotations and their positions
  const fileAnnotations: Array<{ file: string; pos: number; line: number }> = []
  let match: RegExpExecArray | null

  // Reset lastIndex for each regex
  FILE_ANNOTATION_RE.lastIndex = 0
  while ((match = FILE_ANNOTATION_RE.exec(content)) !== null) {
    const filePath = match[1]
    const pos = match.index
    const line = getLineNumber(pos)
    fileAnnotations.push({ file: filePath, pos, line })
  }

  // Add all @file: annotations as file references
  for (const ann of fileAnnotations) {
    addRef(ann.file, null, ann.line)
  }

  // Find all @symbol: annotations and associate with nearest preceding @file:
  SYMBOL_ANNOTATION_RE.lastIndex = 0
  while ((match = SYMBOL_ANNOTATION_RE.exec(content)) !== null) {
    const symbolName = match[1]
    const symPos = match.index
    const symLine = getLineNumber(symPos)

    // Find the nearest preceding @file: annotation
    let nearestFile: string | null = null
    for (const ann of fileAnnotations) {
      if (ann.pos <= symPos) {
        nearestFile = ann.file
      } else {
        break
      }
    }

    if (nearestFile !== null) {
      addRef(nearestFile, symbolName, symLine)
    }
  }

  // ===== Strategy 2: Path pattern matching =====

  PATH_RE.lastIndex = 0
  while ((match = PATH_RE.exec(content)) !== null) {
    const filePath = match[0]
    const pos = match.index
    const line = getLineNumber(pos)
    addRef(filePath, null, line)
  }

  // ===== Strategy 3: Backtick-quoted symbols with nearby file paths =====

  // Collect all file path references (from Strategy 2) for backward lookup
  const pathRefs: Array<{ file: string; pos: number; line: number }> = []

  PATH_RE.lastIndex = 0
  while ((match = PATH_RE.exec(content)) !== null) {
    pathRefs.push({
      file: match[0],
      pos: match.index,
      line: getLineNumber(match.index),
    })
  }

  // Also include @file: annotations
  for (const ann of fileAnnotations) {
    pathRefs.push({ file: ann.file, pos: ann.pos, line: ann.line })
  }

  // Sort by position for nearest-preceding lookup
  pathRefs.sort((a, b) => a.pos - b.pos)

  // Find backtick-quoted symbols and associate with nearest preceding file path
  SYMBOL_RE.lastIndex = 0
  while ((match = SYMBOL_RE.exec(content)) !== null) {
    const symbolName = match[1]
    const symPos = match.index
    const symLine = getLineNumber(symPos)

    // Find the nearest preceding file path reference
    let nearestFile: string | null = null
    for (const pr of pathRefs) {
      if (pr.pos <= symPos) {
        nearestFile = pr.file
      } else {
        break
      }
    }

    if (nearestFile !== null) {
      addRef(nearestFile, symbolName, symLine)
    }
  }

  return Array.from(refMap.values())
}

/**
 * Shared helper: read a spec/plan file, parse metadata, and detect code
 * references. Returns null when the file already has frontmatter.
 *
 * Deduplicates the frontmatter check, basename parsing, docType detection,
 * adrId computation, and code-reference detection that was previously
 * duplicated in generateSpecFrontmatter and previewFrontmatter.
 */
async function buildSpecMetadata(
  filePath: string,
  codebaseRoot: string,
): Promise<{ adrId: string; docType: string; topic: string; now: string; detectedRefs: DetectedRef[]; content: string } | null> {
  const content = await readFile(filePath, 'utf-8')
  if (parseFrontmatter(content)) return null

  const basename = path.basename(filePath)
  const isSpec = /design\.md$/.test(basename)
  const docType = isSpec ? 'spec' : 'plan'

  const now = new Date().toISOString().slice(0, 10)
  const topic = basename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')
  const adrId = `${docType === 'spec' ? 'SPEC' : 'PLAN'}-${now}-${topic}`

  const detectedRefs = detectCodeReferences(content, codebaseRoot)

  return { adrId, docType, topic, now, detectedRefs, content }
}

/**
 * Generate YAML frontmatter for a spec/plan document.
 * Returns null if the document already has frontmatter.
 */
export async function generateSpecFrontmatter(
  filePath: string,
  codebaseRoot: string,
): Promise<GenerateResult | null> {
  const metadata = await buildSpecMetadata(filePath, codebaseRoot)
  if (!metadata) return null

  const { adrId, docType, topic, now, detectedRefs, content } = metadata

  const frontmatter: AdrFrontmatter = {
    id: adrId,
    type: docType,
    status: 'active',
    created: now,
    updated: now,
    author: 'dsh-context-milvus',
    supersedes: null,
    superseded_by: null,
    code_anchors: detectedRefs.map(ref => ({
      file: ref.file,
      symbols: ref.symbols,
      lines: ref.lines,
      git_commit: '',
    })),
    trigger: {
      task_id: null,
      requirement_summary: topic.replace(/-/g, ' '),
      change_type: 'architecture',
    },
    related_decisions: [],
    auto_generated: true,
  }

  // Serialize with js-yaml (key order preserved, no refs)
  const yaml = yamlDump(frontmatter, { lineWidth: 120, noRefs: true, sortKeys: false })
  const newContent = `---\n${yaml}---\n\n${content}`

  // Atomic write via temp file + rename (same pattern as adr-service.ts)
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, newContent, 'utf-8')
  await rename(tmpPath, filePath)

  return { adrId, detectedRefs, generated: true }
}

/**
 * Preview mode: run detection and build the frontmatter object in memory,
 * but do NOT write to disk. Used by the index_specs tool's dry_run mode.
 */
export async function previewFrontmatter(
  filePath: string,
  codebaseRoot: string,
): Promise<GenerateResult | null> {
  const metadata = await buildSpecMetadata(filePath, codebaseRoot)
  if (!metadata) return null

  return { adrId: metadata.adrId, detectedRefs: metadata.detectedRefs, generated: false }
}