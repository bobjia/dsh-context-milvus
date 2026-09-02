---
title: cross-file-import-resolution
type: plan
created: 2026-09-03
status: draft
id: PLAN-2026-09-03-cross-file-import-resolution
---

# Cross-File Import Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add cross-file import resolution to the code relationship analysis system — build an Import Map that maps each imported symbol to its definition file, enabling exact matching in `find_callers` and `trace_call_chain`.

**Architecture:** New `import-resolver.ts` module scans each file's import/export statements at index time using tree-sitter AST, building a bidirectional Import Map persisted as JSON alongside Merkle state. `find_callers` uses the map to filter V1's `json_contains` results by actual import edges. `trace_call_chain` uses `filePath:symbol` composite keys for accurate BFS traversal.

**Tech Stack:** TypeScript, tree-sitter, @deepseek-ai/dsh-tools (defineTool)

## Global Constraints

- Import Map stored as JSON file alongside Merkle state (derived path via `deriveImportMapFilePath`)
- V2 only: direct file-level import resolution (no tsconfig paths, no node_modules, no re-export chains)
- All 9 tree-sitter languages supported; PHP (regex fallback) skipped
- `sourceFile` and `resolve` parameters added to tools; `resolve: false` = full V1 fallback
- Backward compat: existing `references` field and `json_contains` queries unchanged
- No new npm dependencies
- Test invocation: `node --experimental-vm-modules node_modules/.bin/jest`

---

### Task 1: types.ts — Add ResolutionInfo, importNodeTypes, exportNodeTypes, resolveImportPath

**Files:**
- Modify: `src/plugins/dsh-context-milvus/types.ts`
- Test: `test/import-resolver.spec.ts` (Task 8)

**Interfaces:**
- Consumes: nothing new
- Produces: `ResolutionInfo`, `ResolutionStatus`, `LanguageConfig.importNodeTypes`, `LanguageConfig.exportNodeTypes`, `LanguageConfig.resolveImportPath`, `SearchResult.resolution`

- [ ] **Step 1: Add `ResolutionStatus` and `ResolutionInfo` types**

```typescript
/** Resolution status for a cross-file reference */
export type ResolutionStatus = 'resolved' | 'local' | 'unresolved'

/** Cross-file resolution info for a code reference */
export interface ResolutionInfo {
  status: ResolutionStatus
  targetFile?: string   // The file where the symbol is defined (resolved only)
  exportedAs?: string   // The exported symbol name in the target file (resolved only)
}
```

- [ ] **Step 2: Add `resolution` to `SearchResult`**

```typescript
export interface SearchResult {
  filePath: string
  content: string
  score: number
  language: string
  startLine: number
  endLine: number
  name: string
  chunkType: string
  references?: string[]
  resolution?: ResolutionInfo  // NEW: cross-file resolution info
}
```

- [ ] **Step 3: Add `importNodeTypes`, `exportNodeTypes`, `resolveImportPath` to `LanguageConfig`**

```typescript
export interface LanguageConfig {
  name: string
  extensions: string[]
  chunkNodeTypes: string[]
  referenceNodeTypes?: string[]
  importNodeTypes?: string[]    // NEW: AST node types for import statements
  exportNodeTypes?: string[]    // NEW: AST node types for export statements
  resolveImportPath?: (importPath: string, sourceFile: string) => string | null  // NEW
}
```

- [ ] **Step 4: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/types.ts
git commit -m "feat(import-resolve): add ResolutionInfo, importNodeTypes, exportNodeTypes to types"
```

---

### Task 2: chunker.ts — Export getParser, add import/export configs for all languages

**Files:**
- Modify: `src/plugins/dsh-context-milvus/chunker.ts`
- Test: `test/import-resolver.spec.ts` (Task 8)

**Interfaces:**
- Consumes: `LanguageConfig.importNodeTypes`, `exportNodeTypes`, `resolveImportPath` (Task 1)
- Produces: exported `getParser()` and `hasTsParser()` for reuse by import-resolver.ts; per-language `importNodeTypes`, `exportNodeTypes`, `resolveImportPath`

- [ ] **Step 1: Export `getParser` and `hasTsParser` from chunker.ts**

Change `getParser` from file-scoped to exported:

```typescript
// Change from:
async function getParser(ext: string): Promise<any> {
// To:
export async function getParser(ext: string): Promise<any> {
```

Change `hasTsParser` from file-scoped to exported:

```typescript
export function hasTsParser(ext: string): boolean {
  const def = EXT_MAP.get(ext)
  return !!def?.loadTs
}
```

- [ ] **Step 2: Add `importNodeTypes` and `exportNodeTypes` to each language config**

For each language, add the appropriate import/export node types. Only languages that have explicit import/export syntax get these; others derive exports from chunkNodeTypes.

**TypeScript:**

```typescript
{
  config: {
    name: 'typescript',
    // ... existing fields ...
    importNodeTypes: ['import_statement'],
    exportNodeTypes: ['export_statement'],
    resolveImportPath: (importPath: string, sourceFile: string) => {
      // Only handle relative paths: './foo' or '../foo'
      if (!importPath.startsWith('.')) return null
      const dir = path.dirname(sourceFile)
      const resolved = path.resolve(dir, importPath)
      // Try extensions in order
      for (const ext of ['.ts', '.tsx', '.js', '.mjs', '.cjs']) {
        const fullPath = resolved + ext
        // Check existence via fs or just return the best guess
        // For V2, we return the best guess path without existence check
        // (index_code will naturally skip non-existent files later)
        return fullPath
      }
      // Try /index.ts
      return resolved + '/index.ts'
    },
  },
}
```

**JavaScript:**

```typescript
importNodeTypes: ['import_statement'],
exportNodeTypes: ['export_statement'],
resolveImportPath: (importPath: string, sourceFile: string) => {
  if (!importPath.startsWith('.')) return null
  const dir = path.dirname(sourceFile)
  const resolved = path.resolve(dir, importPath)
  for (const ext of ['.js', '.mjs', '.cjs']) {
    return resolved + ext
  }
  return resolved + '/index.js'
},
```

**Python:**

```typescript
importNodeTypes: ['import_from_statement', 'import_statement'],
// No exportNodeTypes — derived from chunkNodeTypes
resolveImportPath: (importPath: string, sourceFile: string) => {
  // from .foo import bar → ./foo.py
  // from foo import bar → ./foo.py (absolute, same package)
  const dir = path.dirname(sourceFile)
  // Relative: starts with '.'
  if (importPath.startsWith('.')) {
    const resolved = path.resolve(dir, importPath)
    return resolved + '.py'
  }
  // Absolute: try same directory
  const candidate = path.resolve(dir, importPath + '.py')
  // Just return the best guess; existence check is at index time
  return candidate
},
```

**Go:**

```typescript
importNodeTypes: ['import_declaration'],
// No exportNodeTypes — derived from chunkNodeTypes (capitalized names)
resolveImportPath: (importPath: string, sourceFile: string) => {
  // Go imports are package paths: "github.com/foo/bar"
  // Map to directory: sourceFile's dir + last segment of import path
  // e.g., import "github.com/foo/bar" → ./vendor/bar/ (package-level)
  if (!importPath) return null
  const dir = path.dirname(sourceFile)
  const pkgName = path.basename(importPath)
  // Try to find the package directory relative to source
  // For V2, just return the directory path
  const pkgDir = path.resolve(dir, pkgName)
  // If it exists as a directory, great; otherwise return null
  return pkgDir  // Caller will check existence
},
```

**Java:**

```typescript
importNodeTypes: ['import_declaration'],
// No exportNodeTypes — derived from chunkNodeTypes (public class)
resolveImportPath: (importPath: string, sourceFile: string) => {
  // import com.example.Foo → ./com/example/Foo.java
  if (!importPath) return null
  const srcDir = path.dirname(path.dirname(sourceFile)) // go up to src root
  const filePath = importPath.replace(/\./g, '/') + '.java'
  return path.resolve(srcDir, filePath)
},
```

**Rust:**

```typescript
importNodeTypes: ['use_declaration'],
// No exportNodeTypes — derived from chunkNodeTypes (pub fn/struct)
resolveImportPath: (importPath: string, sourceFile: string) => {
  // use crate::module::func → ./module.rs
  // use super::module::func → ../module.rs
  if (!importPath) return null
  const dir = path.dirname(sourceFile)
  // Remove crate:: or self:: prefix
  let resolved = importPath
    .replace(/^crate::/, '')
    .replace(/^self::/, '')
    .replace(/^super::/, '../')
  // Take just the module path (first component)
  const parts = resolved.split('::')
  const modulePath = parts.slice(0, -1).join('/') // exclude the function name
  return path.resolve(dir, modulePath + '.rs')
},
```

**C++:**

```typescript
importNodeTypes: ['preproc_include'],
// No exportNodeTypes — derived from chunkNodeTypes
resolveImportPath: (importPath: string, sourceFile: string) => {
  // #include "header.hpp" → ./header.hpp
  if (!importPath) return null
  const dir = path.dirname(sourceFile)
  return path.resolve(dir, importPath)
},
```

**C#:**

```typescript
importNodeTypes: ['using_directive'],
// No exportNodeTypes — derived from chunkNodeTypes (public class)
resolveImportPath: (importPath: string, sourceFile: string) => {
  // using Project.Namespace → ./Project/Namespace/ (directory-level)
  if (!importPath) return null
  const dir = path.dirname(path.dirname(sourceFile))
  const pathSegments = importPath.replace(/\./g, '/')
  return path.resolve(dir, pathSegments)
},
```

**Scala:**

```typescript
importNodeTypes: ['import'],
// No exportNodeTypes — derived from chunkNodeTypes (public object/class)
resolveImportPath: (importPath: string, sourceFile: string) => {
  // import com.example.Foo → ./com/example/Foo.scala
  if (!importPath) return null
  const srcDir = path.dirname(path.dirname(sourceFile))
  const filePath = importPath.replace(/\./g, '/') + '.scala'
  return path.resolve(srcDir, filePath)
},
```

**PHP** — skip, no AST.

- [ ] **Step 3: Add `path` import at the top of chunker.ts**

```typescript
import * as path from 'node:path'
```

- [ ] **Step 4: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/chunker.ts
git commit -m "feat(import-resolve): export getParser, add import/export configs per language"
```

---

### Task 3: config.ts — Add deriveImportMapFilePath

**Files:**
- Modify: `src/plugins/dsh-context-milvus/config.ts`
- Test: verified in Task 8

**Interfaces:**
- Consumes: nothing new
- Produces: `deriveImportMapFilePath(rootPath): string`

- [ ] **Step 1: Add `deriveImportMapFilePath` function**

```typescript
import { createHash } from 'node:crypto'
import * as path from 'node:path'
import * as os from 'node:os'

/**
 * Derive the import map file path for a given root path.
 * Uses the same approach as deriveMerkleFilePath but with a different prefix.
 */
export function deriveImportMapFilePath(rootPath: string): string {
  const hash = createHash('sha256').update(rootPath).digest('hex').slice(0, 16)
  const baseDir = path.join(os.homedir(), '.milvus-index')
  return path.join(baseDir, `import-map-${hash}.json`)
}
```

- [ ] **Step 2: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/plugins/dsh-context-milvus/config.ts
git commit -m "feat(import-resolve): add deriveImportMapFilePath to config"
```

---

### Task 4: import-resolver.ts (NEW) — ImportResolver class

**Files:**
- Create: `src/plugins/dsh-context-milvus/import-resolver.ts`
- Test: `test/import-resolver.spec.ts` (Task 8)

**Interfaces:**
- Consumes: `LanguageConfig.importNodeTypes`, `exportNodeTypes`, `resolveImportPath` (Task 1); `getParser()`, `hasTsParser()`, `getLanguageForExtension()` (Task 2)
- Produces: `ImportResolver` class with `build()`/`load()`/`save()`/`scanFile()`/`removeFile()`/`resolve()`/`isImportedFrom()`/`getStats()`

- [ ] **Step 1: Create the module with type exports and the ImportResolver class**

```typescript
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
   * Scan a single file for import/export statements using tree-sitter ASTM.
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
```

- [ ] **Step 2: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 3: Commit**

```bash
git add src/plugins/dsh-context-milvus/import-resolver.ts
git commit -m "feat(import-resolve): add ImportResolver class with tree-sitter import/export extraction"
```

---

### Task 5: indexer.ts — Integrate ImportResolver into indexing pipeline

**Files:**
- Modify: `src/plugins/dsh-context-milvus/indexer.ts`
- Modify: `src/plugins/dsh-context-milvus/index.ts`
- Test: verified in Task 9

**Interfaces:**
- Consumes: `ImportResolver` (Task 4), `deriveImportMapFilePath` (Task 3)
- Produces: ImportResolver built and saved during `index_code`; `ImportResolver` instance available for tools

- [ ] **Step 1: Add ImportResolver to `runIndex`**

In `indexer.ts`, add import and integrate ImportResolver:

```typescript
import { ImportResolver } from './import-resolver.js'
import { deriveImportMapFilePath } from './config.js'

// In the runIndex function, after establishing the tracker:
```

Add the ImportResolver creation and integration in `runIndex`:

```typescript
export async function runIndex(
  config: PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  options?: {
    mode?: 'full' | 'incremental'
    progress?: (msg: string) => void
    onFileProgress?: (filePath: string) => void
    importResolver?: ImportResolver  // NEW: optional, for import map building
  },
): Promise<IndexResult> {
  // ... existing setup ...

  // 5. Index changed files (existing code)
  // ... existing chunking/embedding/insert logic ...

  // NEW: Build import map for changed files
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

  // 6. Save Merkle state (existing code)
  // ... existing save logic ...
}
```

- [ ] **Step 2: Initialize ImportResolver in `index.ts`**

In `src/plugins/dsh-context-milvus/index.ts`, add ImportResolver initialization:

```typescript
import { ImportResolver } from './import-resolver.js'
import { deriveImportMapFilePath } from './config.js'

// In apply() after the tracker initialization:
const importMapPath = deriveImportMapFilePath(resolved.indexRoot)
const importResolver = new ImportResolver(importMapPath)
await importResolver.load().catch(() => {
  // No import map yet — fresh start
})
```

- [ ] **Step 3: Thread ImportResolver through `registerTools`**

In `index.ts`'s `registerTools` call, pass `importResolver`:

```typescript
registerTools(ctx, () => getConfig(current()), milvus, tracker, importResolver, adrOptions)
```

And pass it through `index_code`'s execute:

```typescript
const codeResult = await runIndex(effectiveConfig, milvus, effectiveTracker, {
  mode,
  progress,
  importResolver: effectiveImportResolver,  // NEW
})
```

- [ ] **Step 4: Update `registerTools` signature in `tools.ts`**

```typescript
export function registerTools(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  importResolver?: ImportResolver,  // NEW
  adrOptions?: { ... },
): void {
```

- [ ] **Step 5: Pass ImportResolver to `index_code` tool's execute**

In `index_code`'s execute, create a workspace-specific ImportResolver if needed:

```typescript
const effectiveImportResolver = overridePath
  ? new ImportResolver(deriveImportMapFilePath(overridePath))
  : importResolver
if (overridePath) await effectiveImportResolver.load().catch(() => {})
```

- [ ] **Step 6: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/plugins/dsh-context-milvus/indexer.ts src/plugins/dsh-context-milvus/index.ts src/plugins/dsh-context-milvus/tools.ts
git commit -m "feat(import-resolve): integrate ImportResolver into indexing pipeline"
```

---

### Task 6: code-relations.ts — Update findCallers/traceChain for V2 resolution

**Files:**
- Modify: `src/plugins/dsh-context-milvus/code-relations.ts`
- Test: `test/code-relations.spec.ts` (Task 9)

**Interfaces:**
- Consumes: `ImportResolver.resolve()` and `isImportedFrom()` (Task 4)
- Produces: updated `findCallers` with resolution info; updated `traceChain` with composite key traversal

- [ ] **Step 1: Add `ResolutionInfo` to `RelationChunk`**

```typescript
import type { ResolutionInfo } from './types.js'

export interface RelationChunk {
  filePath: string
  content: string
  startLine: number
  endLine: number
  chunkType: string
  name: string
  references?: string[]
  resolution?: ResolutionInfo  // NEW
}
```

- [ ] **Step 2: Update `findCallers` to accept and use import resolver**

```typescript
export interface FindCallersOptions {
  maxResults?: number
  sourceFile?: string        // NEW: explicit file qualification
  resolver?: {               // NEW: import resolver interface
    resolve: (filePath: string, symbol: string) => { target: string; exportedAs: string } | null
    getExports: (filePath: string) => string[]
  }
}

export async function findCallers(
  findBySymbol: FindBySymbol,
  symbol: string,
  direction: 'backward' | 'forward' = 'backward',
  options: FindCallersOptions = {},
): Promise<CallersResult> {
  const maxResults = options.maxResults ?? 20
  const resolver = options.resolver

  if (isNoiseSymbol(symbol)) {
    return { chunks: [] }
  }

  const chunks = await findBySymbol(symbol, direction, maxResults)

  // Apply import resolution if available
  if (resolver) {
    const filtered: RelationChunk[] = []

    for (const chunk of chunks) {
      // Try to resolve the symbol
      const entry = resolver.resolve(chunk.filePath, symbol)

      if (entry) {
        // Resolved: symbol is imported from another file
        if (options.sourceFile && entry.target !== options.sourceFile) {
          continue  // Does not match the requested source file
        }
        chunk.resolution = {
          status: 'resolved',
          targetFile: entry.target,
          exportedAs: entry.exportedAs,
        }
        filtered.push(chunk)
      } else {
        // Check if the symbol is defined in the same file (exports contain it)
        const exports = resolver.getExports(chunk.filePath)
        const isLocal = exports.includes(symbol) || chunk.name === symbol

        if (isLocal) {
          if (options.sourceFile && chunk.filePath !== options.sourceFile) {
            continue  // Local call, but not from the requested file
          }
          chunk.resolution = { status: 'local' }
          filtered.push(chunk)
        } else {
          // Unresolved: keep as fallback
          if (options.sourceFile) {
            continue  // Can't verify, exclude
          }
          chunk.resolution = { status: 'unresolved' }
          filtered.push(chunk)
        }
      }
    }

    return { chunks: filtered }
  }

  return { chunks }
}
```

- [ ] **Step 3: Update `traceChain` to use composite keys**

```typescript
export async function traceChain(
  findBySymbol: FindBySymbol,
  entry: string,
  options: TraceOptions & {
    resolver?: {
      resolve: (filePath: string, symbol: string) => { target: string; exportedAs: string } | null
      getExports: (filePath: string) => string[]
    }
  } = {},
): Promise<TraceResult> {
  const direction = options.direction ?? 'backward'
  const maxDepth = options.maxDepth ?? 3
  const maxResults = options.maxResults ?? 10
  const resolver = options.resolver

  if (isNoiseSymbol(entry)) {
    return { chain: [] }
  }

  // Use composite key: filePath:symbol for visited set
  const visited = new Set<string>()
  const chain: ChainNode[] = []
  // Each level item carries: symbol, filePath (for composite key), depth
  let currentLevel: Array<{ symbol: string; filePath: string; depth: number }> = [
    { symbol: entry, filePath: '', depth: 0 },
  ]

  while (currentLevel.length > 0 && maxDepth > 0) {
    const nextLevel: Array<{ symbol: string; filePath: string; depth: number }> = []

    for (const item of currentLevel) {
      const compositeKey = item.filePath ? `${item.filePath}:${item.symbol}` : item.symbol
      if (visited.has(compositeKey)) continue
      visited.add(compositeKey)

      const result = await findCallers(findBySymbol, item.symbol, direction, { maxResults, resolver })

      // Build callers list with composite keys for next level
      const callers: string[] = []
      for (const chunk of result.chunks) {
        // For backward: the caller is the chunk's name
        // For forward: the caller is the resolved reference
        if (direction === 'backward') {
          const callerComposite = chunk.filePath ? `${chunk.filePath}:${chunk.name}` : chunk.name
          callers.push(callerComposite)
        }
      }

      chain.push({
        depth: item.depth,
        symbol: item.symbol,
        filePath: result.chunks.length > 0 ? result.chunks[0].filePath : item.filePath,
        startLine: result.chunks.length > 0 ? result.chunks[0].startLine : 0,
        endLine: result.chunks.length > 0 ? result.chunks[0].endLine : 0,
        callers,
      })

      // Enqueue next level
      if (item.depth < maxDepth - 1) {
        for (const callerComposite of callers) {
          if (!visited.has(callerComposite) && !isNoiseSymbol(callerComposite.split(':').pop()!)) {
            const [fp, sym] = callerComposite.includes(':')
              ? [callerComposite.split(':')[0], callerComposite.split(':').slice(1).join(':')]
              : ['', callerComposite]
            nextLevel.push({ symbol: sym, filePath: fp, depth: item.depth + 1 })
          }
        }
      }
    }

    currentLevel = nextLevel
  }

  return { chain }
}
```

- [ ] **Step 4: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/code-relations.ts
git commit -m "feat(import-resolve): update findCallers/traceChain with import resolution"
```

---

### Task 7: tools.ts — Update tools with sourceFile, resolve params, ImportResolver

**Files:**
- Modify: `src/plugins/dsh-context-milvus/tools.ts`
- Test: `test/code-relations.spec.ts` (Task 9)

**Interfaces:**
- Consumes: `ImportResolver` (Task 4), updated `findCallers`/`traceChain` (Task 6)
- Produces: updated `find_callers` and `trace_call_chain` tools with V2 params

- [ ] **Step 1: Update `find_callers` tool with `sourceFile` and `resolve` params**

```typescript
parameters: {
  symbol: {
    type: 'string',
    required: true,
    description: '要查找的符号名（函数名、变量名、类名）',
  },
  direction: {
    type: 'string',
    description: 'backward=谁引用了我（影响面，默认）；forward=我引用了谁（依赖面）',
  },
  maxResults: {
    type: 'number',
    description: '最大返回结果数，默认 20',
  },
  sourceFile: {
    type: 'string',
    description: '限定定义文件路径（显式消歧，只返回从该文件导入该符号的调用者）',
  },
  resolve: {
    type: 'boolean',
    description: '是否启用 import 解析（默认 true，设为 false 回退到 V1 名称匹配）',
  },
},
```

- [ ] **Step 2: Update `find_callers` execute to use ImportResolver**

```typescript
async execute(params: any, exec?: any) {
  await milvus.ensureCollection()
  const direction = params.direction === 'forward' ? 'forward' as const : 'backward' as const
  const maxResults = params.maxResults ?? 20
  const sourceFile = params.sourceFile as string | undefined
  const resolve = params.resolve !== false

  // Load import resolver if resolve is enabled
  const resolver = resolve && importResolver?.isLoaded() ? importResolver : undefined

  const findBySymbol: FindBySymbol = async (symbol, dir, limit) => {
    if (dir === 'backward') {
      const results = await milvus.queryByReference(symbol, limit)
      return results.map(r => ({
        filePath: r.filePath,
        content: r.content,
        startLine: r.startLine,
        endLine: r.endLine,
        chunkType: r.chunkType,
        name: r.name,
      }))
    } else {
      const results = await milvus.queryByName(symbol, limit)
      return results.map(r => ({
        filePath: r.filePath,
        content: r.content,
        startLine: r.startLine,
        endLine: r.endLine,
        chunkType: r.chunkType,
        name: r.name,
        references: (r as any).references ?? [],
      }))
    }
  }

  return findCallers(findBySymbol, params.symbol, direction, {
    maxResults,
    sourceFile,
    resolver: resolver ? {
      resolve: (fp, sym) => resolver.resolve(fp, sym),
      getExports: (fp) => resolver.getExports(fp),
    } : undefined,
  })
},
```

- [ ] **Step 3: Update `trace_call_chain` tool with `resolve` param**

```typescript
parameters: {
  entry: { type: 'string', required: true, description: '入口符号名' },
  direction: { type: 'string', description: 'backward=影响分析（默认）；forward=依赖分析' },
  maxDepth: { type: 'number', description: '最大递归深度，默认 3' },
  maxResults: { type: 'number', description: '每层最大结果数，默认 10' },
  resolve: { type: 'boolean', description: '是否启用 import 解析（默认 true）' },
},
```

- [ ] **Step 4: Update `trace_call_chain` execute**

```typescript
async execute(params: any, exec?: any) {
  await milvus.ensureCollection()
  const direction = params.direction === 'forward' ? 'forward' as const : 'backward' as const
  const maxDepth = params.maxDepth ?? 3
  const maxResults = params.maxResults ?? 10
  const resolve = params.resolve !== false

  const resolver = resolve && importResolver?.isLoaded() ? importResolver : undefined

  const findBySymbol: FindBySymbol = async (symbol, dir, limit) => {
    // ... same as find_callers ...
  }

  return traceChain(findBySymbol, params.entry, {
    direction, maxDepth, maxResults,
    resolver: resolver ? {
      resolve: (fp, sym) => resolver.resolve(fp, sym),
      getExports: (fp) => resolver.getExports(fp),
    } : undefined,
  })
},
```

- [ ] **Step 5: Add ImportResolver import to tools.ts**

```typescript
import { ImportResolver } from './import-resolver.js'
```

- [ ] **Step 6: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 7: Commit**

```bash
git add src/plugins/dsh-context-milvus/tools.ts
git commit -m "feat(import-resolve): update tools with sourceFile/resolve params and ImportResolver"
```

---

### Task 8: test/import-resolver.spec.ts — Unit tests for ImportResolver

**Files:**
- Create: `test/import-resolver.spec.ts`

**Interfaces:**
- Consumes: `ImportResolver` (Task 4), `ImportEntry` (Task 4)
- Produces: unit test coverage for ImportResolver

- [ ] **Step 1: Create the test file**

```typescript
import { describe, expect, test, jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// Mock the chunker module for ImportResolver
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({})),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'RRF' },
  load: jest.fn(),
}))

describe('ImportResolver', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'import-resolver-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  test('starts with empty map', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver(path.join(tempDir, 'import-map.json'))
    await resolver.load()
    const stats = resolver.getStats()
    expect(stats.filesWithImports).toBe(0)
    expect(stats.filesWithExports).toBe(0)
    expect(stats.totalImportEdges).toBe(0)
  })

  test('persists and reloads', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const mapPath = path.join(tempDir, 'import-map.json')

    // Create and save
    const resolver1 = new ImportResolver(mapPath)
    await resolver1.load()
    resolver1['map'] = {
      imports: {
        'src/a.ts': { foo: { target: 'src/b.ts', exportedAs: 'foo' } },
      },
      exports: {
        'src/b.ts': ['foo', 'bar'],
      },
    }
    await resolver1.save()

    // Reload
    const resolver2 = new ImportResolver(mapPath)
    await resolver2.load()
    expect(resolver2.resolve('src/a.ts', 'foo')).toEqual({ target: 'src/b.ts', exportedAs: 'foo' })
    expect(resolver2.getExports('src/b.ts')).toEqual(['foo', 'bar'])
  })

  test('resolve returns null for unknown symbol', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver(path.join(tempDir, 'map.json'))
    await resolver.load()
    expect(resolver.resolve('src/a.ts', 'nonexistent')).toBeNull()
  })

  test('removeFile clears entries', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver(path.join(tempDir, 'map.json'))
    await resolver.load()
    resolver['map'] = {
      imports: { 'src/a.ts': { foo: { target: 'src/b.ts', exportedAs: 'foo' } } },
      exports: { 'src/b.ts': ['foo'] },
    }
    resolver.removeFile('src/a.ts')
    expect(resolver.resolve('src/a.ts', 'foo')).toBeNull()
    resolver.removeFile('src/b.ts')
    expect(resolver.getExports('src/b.ts')).toEqual([])
  })

  test('isImportedFrom checks exact import edge', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver(path.join(tempDir, 'map.json'))
    await resolver.load()
    resolver['map'] = {
      imports: { 'src/a.ts': { foo: { target: 'src/b.ts', exportedAs: 'foo' } } },
      exports: {},
    }
    expect(resolver.isImportedFrom('src/a.ts', 'foo', 'src/b.ts')).toBe(true)
    expect(resolver.isImportedFrom('src/a.ts', 'foo', 'src/c.ts')).toBe(false)
    expect(resolver.isImportedFrom('src/x.ts', 'foo', 'src/b.ts')).toBe(false)
  })

  test('getStats returns correct counts', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver(path.join(tempDir, 'map.json'))
    await resolver.load()
    resolver['map'] = {
      imports: {
        'a.ts': { x: { target: 'c.ts', exportedAs: 'x' }, y: { target: 'c.ts', exportedAs: 'y' } },
        'b.ts': { z: { target: 'c.ts', exportedAs: 'z' } },
      },
      exports: { 'c.ts': ['x', 'y', 'z'] },
    }
    const stats = resolver.getStats()
    expect(stats.filesWithImports).toBe(2)
    expect(stats.filesWithExports).toBe(1)
    expect(stats.totalImportEdges).toBe(3)
    expect(stats.totalExportSymbols).toBe(3)
  })
})

describe('ImportResolver scanFile', () => {
  test('extracts TypeScript imports', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver('/tmp/test-map.json')
    await resolver.load()

    const content = `
      import { parseConfig } from './config'
      import { initDb } from './database'
      export function runApp() { return parseConfig() + initDb() }
    `
    await resolver.scanFile('/project/src/app.ts', content, '.ts')

    // Should extract imports from import_statement nodes
    const parseConfigEntry = resolver.resolve('/project/src/app.ts', 'parseConfig')
    expect(parseConfigEntry).not.toBeNull()
    expect(parseConfigEntry!.target).toContain('/project/src/config')
    expect(parseConfigEntry!.exportedAs).toBe('parseConfig')

    const initDbEntry = resolver.resolve('/project/src/app.ts', 'initDb')
    expect(initDbEntry).not.toBeNull()
    expect(initDbEntry!.target).toContain('/project/src/database')
  })

  test('handles file with no imports', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver('/tmp/test-map.json')
    await resolver.load()

    const content = 'export function helper() { return 42 }'
    await resolver.scanFile('/project/src/helper.ts', content, '.ts')

    // Should have exports but no imports
    const exports = resolver.getExports('/project/src/helper.ts')
    expect(exports).toContain('helper')
    expect(resolver.resolve('/project/src/helper.ts', 'anything')).toBeNull()
  })

  test('handles files with no tree-sitter parser (PHP)', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver('/tmp/test-map.json')
    await resolver.load()

    const content = '<?php function foo() { return bar(); }'
    await resolver.scanFile('/project/src/foo.php', content, '.php')

    // PHP should be skipped (no tree-sitter parser)
    const stats = resolver.getStats()
    expect(stats.filesWithImports).toBe(0)
  })

  test('deduplicates on re-scan', async () => {
    const { ImportResolver } = await import('../src/plugins/dsh-context-milvus/import-resolver.js')
    const resolver = new ImportResolver('/tmp/test-map.json')
    await resolver.load()

    // First scan
    const content1 = 'import { foo } from "./bar"\nexport const x = foo()'
    await resolver.scanFile('/project/src/a.ts', content1, '.ts')
    expect(resolver.resolve('/project/src/a.ts', 'foo')).not.toBeNull()

    // Second scan with different imports
    const content2 = 'import { baz } from "./qux"\nexport const x = baz()'
    await resolver.scanFile('/project/src/a.ts', content2, '.ts')

    // Old import should be gone, new one should be there
    expect(resolver.resolve('/project/src/a.ts', 'foo')).toBeNull()
    expect(resolver.resolve('/project/src/a.ts', 'baz')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
node --experimental-vm-modules node_modules/.bin/jest test/import-resolver.spec.ts --verbose
```

- [ ] **Step 3: Commit**

```bash
git add test/import-resolver.spec.ts
git commit -m "test(import-resolve): add unit tests for ImportResolver"
```

---

### Task 9: test/code-relations.spec.ts — Extend integration tests for V2

**Files:**
- Modify: `test/code-relations.spec.ts`

**Interfaces:**
- Consumes: updated `findCallers` and `traceChain` (Task 6)
- Produces: integration tests for V2 resolution

- [ ] **Step 1: Add V2 resolution tests**

Add to the existing `describe('code-relations')` block:

```typescript
// ── V2 Import Resolution ────────────────────────────────────────────

const mockResolver = {
  resolve: (filePath: string, symbol: string) => {
    if (filePath === 'src/app.ts' && symbol === 'parseConfig') {
      return { target: 'src/config.ts', exportedAs: 'parseConfig' }
    }
    if (filePath === 'src/main.ts' && symbol === 'parseConfig') {
      return { target: 'src/config.ts', exportedAs: 'parseConfig' }
    }
    if (filePath === 'src/legacy.ts' && symbol === 'parseConfig') {
      return { target: 'src/vendor/legacy.ts', exportedAs: 'parseConfig' }
    }
    return null
  },
  getExports: (filePath: string) => {
    if (filePath === 'src/config.ts') return ['parseConfig', 'setupLogger']
    if (filePath === 'src/vendor/legacy.ts') return ['parseConfig', 'oldHelper']
    if (filePath === 'src/app.ts') return ['runApp']
    return []
  },
}

test('findCallers with resolver groups by definition file', async () => {
  const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

  const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
    return [
      { filePath: 'src/app.ts', content: '...', startLine: 1, endLine: 10, chunkType: 'function_declaration', name: 'runApp' },
      { filePath: 'src/main.ts', content: '...', startLine: 5, endLine: 15, chunkType: 'function_declaration', name: 'main' },
      { filePath: 'src/legacy.ts', content: '...', startLine: 20, endLine: 30, chunkType: 'function_declaration', name: 'legacyFunc' },
    ]
  }

  const result = await findCallers(mockFindBySymbol as any, 'parseConfig', 'backward', {
    maxResults: 20,
    resolver: mockResolver as any,
  })

  // Should have 3 results, all resolved
  expect(result.chunks).toHaveLength(3)
  expect(result.chunks.every(c => c.resolution?.status === 'resolved')).toBe(true)

  // src/app.ts and src/main.ts should resolve to src/config.ts
  const configCallers = result.chunks.filter(
    c => c.resolution?.targetFile === 'src/config.ts'
  )
  expect(configCallers).toHaveLength(2)

  // src/legacy.ts should resolve to src/vendor/legacy.ts
  const legacyCallers = result.chunks.filter(
    c => c.resolution?.targetFile === 'src/vendor/legacy.ts'
  )
  expect(legacyCallers).toHaveLength(1)
})

test('findCallers with sourceFile filters by definition file', async () => {
  const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

  const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
    return [
      { filePath: 'src/app.ts', content: '...', startLine: 1, endLine: 10, chunkType: 'function_declaration', name: 'runApp' },
      { filePath: 'src/legacy.ts', content: '...', startLine: 20, endLine: 30, chunkType: 'function_declaration', name: 'legacyFunc' },
    ]
  }

  const result = await findCallers(mockFindBySymbol as any, 'parseConfig', 'backward', {
    maxResults: 20,
    sourceFile: 'src/config.ts',
    resolver: mockResolver as any,
  })

  // Only src/app.ts imports parseConfig from src/config.ts
  expect(result.chunks).toHaveLength(1)
  expect(result.chunks[0].filePath).toBe('src/app.ts')
  expect(result.chunks[0].resolution?.status).toBe('resolved')
  expect(result.chunks[0].resolution?.targetFile).toBe('src/config.ts')
})

test('findCallers without resolver falls back to V1 behavior', async () => {
  const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

  const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
    return [
      { filePath: 'src/app.ts', content: '...', startLine: 1, endLine: 10, chunkType: 'function_declaration', name: 'runApp' },
    ]
  }

  const result = await findCallers(mockFindBySymbol as any, 'parseConfig', 'backward', {
    maxResults: 20,
    // No resolver = V1 behavior
  })

  expect(result.chunks).toHaveLength(1)
  expect(result.chunks[0].resolution).toBeUndefined()
})

test('traceChain with resolver uses composite keys', async () => {
  const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

  const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
    if (symbol === 'parseConfig') {
      return [
        { filePath: 'src/app.ts', content: '', startLine: 1, endLine: 5, chunkType: 'function', name: 'runApp', resolution: { status: 'resolved' as const, targetFile: 'src/config.ts', exportedAs: 'parseConfig' } },
      ]
    }
    if (symbol === 'runApp') {
      return [
        { filePath: 'src/main.ts', content: '', startLine: 10, endLine: 20, chunkType: 'function', name: 'main', resolution: { status: 'resolved' as const, targetFile: 'src/app.ts', exportedAs: 'runApp' } },
      ]
    }
    return []
  }

  const result = await traceChain(mockFindBySymbol as any, 'parseConfig', {
    maxDepth: 3,
    resolver: mockResolver as any,
  })

  expect(result.chain.length).toBeGreaterThanOrEqual(2)
  expect(result.chain[0].symbol).toBe('parseConfig')
  // Callers should include filePath:name composite keys
  expect(result.chain[0].callers.some((c: string) => c.includes('src/app.ts'))).toBe(true)
})
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
node --experimental-vm-modules node_modules/.bin/jest test/code-relations.spec.ts --verbose
```

- [ ] **Step 3: Commit**

```bash
git add test/code-relations.spec.ts
git commit -m "test(import-resolve): add V2 integration tests for findCallers/traceChain"
```

---

### Task 10: AGENTS.md — Update documentation

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: nothing
- Produces: updated AGENTS.md with new tool parameters and usage rules

- [ ] **Step 1: Update tool table entries**

Add `sourceFile` and `resolve` to the existing tool rows:

```markdown
| `find_callers` | 查找代码中引用某个符号的所有位置，支持跨文件 import 精确解析 | `symbol`(必填)、`direction`、`maxResults`、`sourceFile`、`resolve` |
| `trace_call_chain` | 从入口符号出发 BFS 追踪调用链，支持 import 解析消歧 | `entry`(必填)、`direction`、`maxDepth`、`maxResults`、`resolve` |
```

- [ ] **Step 2: Add usage rule for import resolution**

```markdown
9. **跨文件精确匹配用 sourceFile 参数**

   当 `find_callers` 返回了多个同名不同文件的符号时，用 `sourceFile` 参数限定只查从特定文件导入的调用者：
   `find_callers(symbol="parseConfig", sourceFile="src/config.ts")`。

10. **import 解析默认启用，可关闭**

    `resolve: false` 可回退到 V1 名称匹配模式。当 import map 未构建时，系统自动降级。
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs(import-resolve): update AGENTS.md with sourceFile/resolve params"
```