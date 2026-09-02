/**
 * Import resolver — cross-file import/export analysis for code relationship analysis.
 *
 * Scans each file's import/export statements at index time using tree-sitter AST,
 * builds a bidirectional Import Map (imports + exports) persisted as JSON.
 * Used by find_callers and trace_call_chain for exact cross-file reference matching.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { existsSync } from 'node:fs'
import { getParser, hasTsParser, getLanguageForExtension } from './chunker.js'
import type { LanguageConfig } from './types.js'

/** A single import entry: where a symbol comes from */
export interface ImportEntry {
  target: string      // Absolute path to the definition file
  exportedAs: string  // The exported symbol name in the target file
}

/** The persisted import map structure */
export interface ImportMap {
  imports: Record<string, Record<string, ImportEntry>>  // filePath → {symbol → ImportEntry}
  exports: Record<string, string[]>                      // filePath → [exportedSymbol, ...]
}

/** Stats for monitoring */
export interface ImportMapStats {
  filesWithImports: number
  filesWithExports: number
  totalImportEdges: number
  totalExportSymbols: number
}

/** Default empty import map */
function emptyMap(): ImportMap {
  return { imports: {}, exports: {} }
}

/**
 * Resolve a relative import path against a source file's directory.
 * Tries the path directly (for cases like ./foo.ts where extension is provided).
 */
function resolveImportPathWithFallback(
  importPath: string,
  sourceFile: string,
  extensions: string[],
): string | null {
  if (!importPath.startsWith('.') && !importPath.startsWith('/')) {
    // Non-relative path (e.g., just "lodash") — skip for V2
    return null
  }
  const dir = path.dirname(sourceFile)
  const resolved = path.resolve(dir, importPath)

  // If the path already has an extension, return as-is
  if (path.extname(resolved)) return resolved

  // Try extensions
  for (const ext of extensions) {
    const candidate = resolved + ext
    if (existsSync(candidate)) return candidate
  }

  // Try /index.{ext}
  for (const ext of extensions) {
    const candidate = path.join(resolved, 'index' + ext)
    if (existsSync(candidate)) return candidate
  }

  return resolved  // best guess
}

export class ImportResolver {
  private map: ImportMap = emptyMap()
  private mapPath: string
  private loaded = false

  constructor(mapPath: string) {
    this.mapPath = mapPath
  }

  // ── Persistence ────────────────────────────────────────────────────

  async load(): Promise<void> {
    try {
      const content = await readFile(this.mapPath, 'utf-8')
      this.map = JSON.parse(content) as ImportMap
      this.loaded = true
    } catch {
      this.map = emptyMap()
      this.loaded = false
    }
  }

  async save(): Promise<void> {
    const dir = path.dirname(this.mapPath)
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
    await writeFile(this.mapPath, JSON.stringify(this.map, null, 2), 'utf-8')
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  // ── File scanning ──────────────────────────────────────────────────

  /**
   * Scan a single file for import/export statements using tree-sitter AST.
   * Updates the import map in-place.
   */
  async scanFile(filePath: string, content: string, ext: string): Promise<void> {
    // Remove old entries for this file first
    this.removeFile(filePath)

    const langConfig = getLanguageForExtension(ext)
    if (!langConfig) return

    // Use tree-sitter if available, otherwise skip
    if (!hasTsParser(ext)) {
      // PHP: no AST, skip import resolution
      return
    }

    try {
      const parser = await getParser(ext)
      const tree = parser.parse(content)
      const root = tree.rootNode

      // Extract imports
      if (langConfig.importNodeTypes && langConfig.importNodeTypes.length > 0) {
        this.extractImports(root, filePath, langConfig)
      }

      // Extract exports
      if (langConfig.exportNodeTypes && langConfig.exportNodeTypes.length > 0) {
        this.extractExports(root, filePath, langConfig)
      }

      // For languages without explicit exportNodeTypes, derive from chunkNodeTypes
      if (!langConfig.exportNodeTypes || langConfig.exportNodeTypes.length === 0) {
        this.deriveExportsFromChunks(root, filePath, langConfig)
      }
    } catch {
      // Parsing failed — skip this file
    }
  }

  /** Remove a file's entries from the import map */
  removeFile(filePath: string): void {
    delete this.map.imports[filePath]
    delete this.map.exports[filePath]
  }

  // ── Querying ───────────────────────────────────────────────────────

  /**
   * Resolve which file a symbol is imported from.
   * Returns null if the symbol is not imported (local definition or unresolved).
   */
  resolve(filePath: string, symbol: string): ImportEntry | null {
    return this.map.imports[filePath]?.[symbol] ?? null
  }

  /** Get all symbols exported by a file */
  getExports(filePath: string): string[] {
    return this.map.exports[filePath] ?? []
  }

  /** Check if a file imports a symbol from a specific target file */
  isImportedFrom(filePath: string, symbol: string, targetFile: string): boolean {
    const entry = this.resolve(filePath, symbol)
    return entry !== null && entry.target === targetFile
  }

  /** Get stats about the current import map */
  getStats(): ImportMapStats {
    const filesWithImports = Object.keys(this.map.imports).length
    const filesWithExports = Object.keys(this.map.exports).length
    let totalImportEdges = 0
    let totalExportSymbols = 0
    for (const file of Object.keys(this.map.imports)) {
      totalImportEdges += Object.keys(this.map.imports[file]).length
    }
    for (const file of Object.keys(this.map.exports)) {
      totalExportSymbols += this.map.exports[file].length
    }
    return { filesWithImports, filesWithExports, totalImportEdges, totalExportSymbols }
  }

  // ── Private helpers ────────────────────────────────────────────────

  private extractImports(root: any, filePath: string, config: LanguageConfig): void {
    const importTypes = new Set(config.importNodeTypes!)
    const entries: Record<string, ImportEntry> = {}
    const resolveFn = config.resolveImportPath

    function walk(node: any): void {
      if (!node || !node.type) return

      if (importTypes.has(node.type)) {
        const extracted = extractImportFromNode(node, filePath, resolveFn)
        if (extracted) {
          for (const { symbol, entry } of extracted) {
            entries[symbol] = entry
          }
        }
      }

      if (node.childCount > 0) {
        for (const child of node.children) {
          walk(child)
        }
      }
    }

    walk(root)
    if (Object.keys(entries).length > 0) {
      this.map.imports[filePath] = entries
    }
  }

  private extractExports(root: any, filePath: string, config: LanguageConfig): void {
    const exportTypes = new Set(config.exportNodeTypes!)
    const symbols: string[] = []

    function walk(node: any): void {
      if (!node || !node.type) return

      if (exportTypes.has(node.type)) {
        const extracted = extractExportSymbols(node)
        if (extracted) {
          for (const sym of extracted) {
            if (!symbols.includes(sym)) symbols.push(sym)
          }
        }
      }

      if (node.childCount > 0) {
        for (const child of node.children) {
          walk(child)
        }
      }
    }

    walk(root)
    if (symbols.length > 0) {
      this.map.exports[filePath] = symbols
    }
  }

  private deriveExportsFromChunks(root: any, filePath: string, config: LanguageConfig): void {
    const chunkTypes = new Set(config.chunkNodeTypes)
    const symbols: string[] = []

    function walk(node: any): void {
      if (!node || !node.type) return

      if (chunkTypes.has(node.type)) {
        // Extract node name using the same logic as extractNodeName
        const nameNode =
          node.childForFieldName('name') ??
          node.childForFieldName('type') ??
          node.childForFieldName('identifier')
        if (nameNode) {
          symbols.push(nameNode.text)
        }
      }

      if (node.childCount > 0) {
        for (const child of node.children) {
          walk(child)
        }
      }
    }

    walk(root)
    // Deduplicate
    const unique = [...new Set(symbols)]
    if (unique.length > 0) {
      this.map.exports[filePath] = unique
    }
  }
}

// ── Import/export extraction helpers ─────────────────────────────────

/** ExtractImportResult: one or more (symbol → ImportEntry) pairs from an import node */
interface ExtractImportResult {
  symbol: string
  entry: ImportEntry
}

function extractImportFromNode(
  node: any,
  sourceFile: string,
  resolveFn?: (importPath: string, sourceFile: string) => string | null,
): ExtractImportResult[] | null {
  const results: ExtractImportResult[] = []

  switch (node.type) {
    case 'import_statement': {
      // TypeScript/JS: import { X } from './foo'  or  import X from './foo'
      const sourceNode = node.childForFieldName('source')
      if (!sourceNode) return null
      const importPath = sourceNode.text.replace(/['"]/g, '')
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null

      // Extract named imports
      const specifiers = node.descendantsOfType('import_specifier')
      for (const spec of specifiers) {
        const name = spec.childForFieldName('name')?.text
        if (name) {
          results.push({
            symbol: name,
            entry: { target: targetFile, exportedAs: name },
          })
        }
      }

      // Default import: import X from './foo'
      const defaultSpec = node.descendantsOfType('import_clause')
      for (const clause of defaultSpec) {
        const defaultName = clause.childForFieldName('name')?.text
        if (defaultName && results.every(r => r.symbol !== defaultName)) {
          results.push({
            symbol: defaultName,
            entry: { target: targetFile, exportedAs: 'default' },
          })
        }
      }
      break
    }

    case 'import_from_statement': {
      // Python: from .foo import bar
      const moduleNode = node.childForFieldName('module_name')
      if (!moduleNode) return null
      const importPath = moduleNode.text
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null

      const names = node.descendantsOfType('dotted_name')
      const nameNode = node.childForFieldName('name')
      if (nameNode) {
        results.push({
          symbol: nameNode.text,
          entry: { target: targetFile, exportedAs: nameNode.text },
        })
      }
      for (const n of names) {
        results.push({
          symbol: n.text,
          entry: { target: targetFile, exportedAs: n.text },
        })
      }
      break
    }

    case 'import_statement': {
      // Python: import foo
      const moduleNode = node.childForFieldName('name')
      if (!moduleNode) return null
      const importPath = moduleNode.text
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null
      results.push({
        symbol: importPath.split('.').pop()!,
        entry: { target: targetFile, exportedAs: importPath },
      })
      break
    }

    case 'import_declaration': {
      // Go: import "pkg"  or  import pkg "pkg"
      // Java: import com.example.Foo
      const pathNode = node.childForFieldName('path')
      const nameNode = node.childForFieldName('name')
      if (!pathNode) return null
      const importPath = pathNode.text.replace(/['"]/g, '')
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null

      // Go: name is the package alias, otherwise last segment
      const symbol = nameNode?.text ?? importPath.split('/').pop()!
      results.push({
        symbol,
        entry: { target: targetFile, exportedAs: importPath },
      })
      break
    }

    case 'use_declaration': {
      // Rust: use crate::module::func
      const argument = node.childForFieldName('argument')
      if (!argument) return null
      const importPath = argument.text
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null
      const symbol = importPath.split('::').pop()!
      results.push({
        symbol,
        entry: { target: targetFile, exportedAs: importPath },
      })
      break
    }

    case 'preproc_include': {
      // C++: #include "header.hpp"
      const pathNode = node.childForFieldName('path')
      if (!pathNode) return null
      const importPath = pathNode.text.replace(/['"<>]/g, '')
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null
      const symbol = path.basename(importPath, path.extname(importPath))
      results.push({
        symbol,
        entry: { target: targetFile, exportedAs: symbol },
      })
      break
    }

    case 'using_directive': {
      // C#: using System;
      // No specific symbol extraction — C# using is namespace-level
      // We'll handle it the same as Go: directory-level
      const nameNode = node.childForFieldName('name')
      if (!nameNode) return null
      const importPath = nameNode.text
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null
      const symbol = importPath.split('.').pop()!
      results.push({
        symbol,
        entry: { target: targetFile, exportedAs: importPath },
      })
      break
    }

    case 'import': {
      // Scala: import com.example.Foo
      const pathNode = node.childForFieldName('path')
      if (!pathNode) return null
      const importPath = pathNode.text
      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null
      const symbol = importPath.split('.').pop()!
      results.push({
        symbol,
        entry: { target: targetFile, exportedAs: importPath },
      })
      break
    }
  }

  return results.length > 0 ? results : null
}

function extractExportSymbols(node: any): string[] | null {
  const symbols: string[] = []

  switch (node.type) {
    case 'export_statement': {
      // TypeScript/JS: export function X, export const X, export { X }, export default X
      const declaration = node.childForFieldName('declaration')
      if (declaration) {
        const name = declaration.childForFieldName('name')
        if (name) symbols.push(name.text)
      }
      // export { X, Y as Z }
      const specifiers = node.descendantsOfType('export_specifier')
      for (const spec of specifiers) {
        const name = spec.childForFieldName('name')?.text
        if (name) symbols.push(name)
      }
      // export default
      const defaultClause = node.childForFieldName('default')
      if (defaultClause) {
        const name = defaultClause.childForFieldName('name')
        if (name) symbols.push(name.text)
      }
      break
    }
  }

  return symbols.length > 0 ? symbols : null
}