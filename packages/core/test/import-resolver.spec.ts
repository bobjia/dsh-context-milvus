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
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(tempDir, 'import-map.json'))
    await resolver.load()
    const stats = resolver.getStats()
    expect(stats.filesWithImports).toBe(0)
    expect(stats.filesWithExports).toBe(0)
    expect(stats.totalImportEdges).toBe(0)
  })

  test('persists and reloads', async () => {
    const { ImportResolver } = await import('../src/import-resolver.js')
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
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(tempDir, 'map.json'))
    await resolver.load()
    expect(resolver.resolve('src/a.ts', 'nonexistent')).toBeNull()
  })

  test('removeFile clears entries', async () => {
    const { ImportResolver } = await import('../src/import-resolver.js')
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
    const { ImportResolver } = await import('../src/import-resolver.js')
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
    const { ImportResolver } = await import('../src/import-resolver.js')
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
  // The resolver resolves imports against `path.resolve`, so tests must feed it
  // native absolute paths (posix `/project/...` becomes `E:\project\...` on
  // Windows and breaks the Kotlin package-segment walk). Build one here.
  const nativeRoot = path.join(path.parse(process.cwd()).root, 'project')
  const nativeTmp = path.join(path.parse(process.cwd()).root, 'tmp')

  // These tests depend on tree-sitter native modules which may not load
  // reliably in the ESM Jest environment. Guard by actually trying to
  // create a parser and parse a TypeScript snippet.
  let tsAvailable = false

  beforeAll(async () => {
    try {
      const { getParser } = await import('../src/chunker.js')
      const parser = await getParser('.ts')
      const tree = parser.parse('const x = 1')
      tsAvailable = tree && tree.rootNode && tree.rootNode.type === 'program'
    } catch {
      tsAvailable = false
    }
  })

  let cAvailable = false

  beforeAll(async () => {
    try {
      const { getParser } = await import('../src/chunker.js')
      const parser = await getParser('.c')
      const tree = parser.parse('int main(void) { return 0; }')
      cAvailable = tree && tree.rootNode && tree.rootNode.type === 'translation_unit'
    } catch {
      cAvailable = false
    }
  })

  let kotlinAvailable = false

  beforeAll(async () => {
    try {
      const { getParser } = await import('../src/chunker.js')
      const parser = await getParser('.kt')
      const tree = parser.parse('fun main() {}')
      kotlinAvailable = tree && tree.rootNode && tree.rootNode.type === 'source_file'
    } catch {
      kotlinAvailable = false
    }
  })

  test('extracts TypeScript imports', async () => {
    if (!tsAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(nativeTmp, 'test-map.json'))
    await resolver.load()

    const content = `
      import { parseConfig } from './config'
      import { initDb } from './database'
      export function runApp() { return parseConfig() + initDb() }
    `
    await resolver.scanFile(path.join(nativeRoot, 'src', 'app.ts'), content, '.ts')

    // Should extract imports from import_statement nodes
    const parseConfigEntry = resolver.resolve(path.join(nativeRoot, 'src', 'app.ts'), 'parseConfig')
    expect(parseConfigEntry).not.toBeNull()
    expect(parseConfigEntry!.target).toContain(path.join(nativeRoot, 'src', 'config'))
    expect(parseConfigEntry!.exportedAs).toBe('parseConfig')

    const initDbEntry = resolver.resolve(path.join(nativeRoot, 'src', 'app.ts'), 'initDb')
    expect(initDbEntry).not.toBeNull()
    expect(initDbEntry!.target).toContain(path.join(nativeRoot, 'src', 'database'))
  })

  test('extracts C #include imports and exports', async () => {
    if (!cAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(nativeTmp, 'test-map.json'))
    await resolver.load()

    const content = `
      #include "myutil.h"
      #include <stdio.h>
      int helper(void);
      int main(void) { return helper(); }
    `
    await resolver.scanFile(path.join(nativeRoot, 'src', 'main.c'), content, '.c')

    // #include "myutil.h" → target ./myutil.h, symbol myutil
    const myutilEntry = resolver.resolve(path.join(nativeRoot, 'src', 'main.c'), 'myutil')
    expect(myutilEntry).not.toBeNull()
    expect(myutilEntry!.target).toBe(path.join(nativeRoot, 'src', 'myutil.h'))
    expect(myutilEntry!.exportedAs).toBe('myutil')

    // main and helper should be exported as chunk symbols
    const exports = resolver.getExports(path.join(nativeRoot, 'src', 'main.c'))
    expect(exports).toContain('main')
    expect(exports).toContain('helper')
  })

  test('extracts Kotlin imports and exports', async () => {
    if (!kotlinAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(nativeTmp, 'test-map.json'))
    await resolver.load()

    const content = `
      package com.example

      import com.example.Bar
      import com.example.util.*
      import com.example.Legacy as Old

      const val MAX = 10

      fun helper(): Int {
        return MAX
      }
    `
    await resolver.scanFile(path.join(nativeRoot, 'com', 'example', 'Usage.kt'), content, '.kt')

    // Kotlin's `import` node has no `path` field — the qualified_identifier is the
    // first named child. The source root is inferred by anchoring the import's
    // top-level segment (`com`) in the importing file's directory chain.
    const barEntry = resolver.resolve(path.join(nativeRoot, 'com', 'example', 'Usage.kt'), 'Bar')
    expect(barEntry).not.toBeNull()
    expect(barEntry!.target).toBe(path.join(nativeRoot, 'com', 'example', 'Bar.kt'))
    expect(barEntry!.exportedAs).toBe('com.example.Bar')

    // `as` alias: the symbol is the alias, not the last path segment
    const aliasEntry = resolver.resolve(path.join(nativeRoot, 'com', 'example', 'Usage.kt'), 'Old')
    expect(aliasEntry).not.toBeNull()
    expect(aliasEntry!.target).toBe(path.join(nativeRoot, 'com', 'example', 'Legacy.kt'))

    // Star imports are skipped entirely — no symbol named `*`
    expect(resolver.resolve(path.join(nativeRoot, 'com', 'example', 'Usage.kt'), '*')).toBeNull()

    // Exports are derived from chunks, including the property binding name
    const exports = resolver.getExports(path.join(nativeRoot, 'com', 'example', 'Usage.kt'))
    expect(exports).toContain('helper')
    expect(exports).toContain('MAX')
  })

  test('handles file with no imports', async () => {
    if (!tsAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(nativeTmp, 'test-map.json'))
    await resolver.load()

    const content = 'export function helper() { return 42 }'
    await resolver.scanFile(path.join(nativeRoot, 'src', 'helper.ts'), content, '.ts')

    // Should have exports but no imports
    const exports = resolver.getExports(path.join(nativeRoot, 'src', 'helper.ts'))
    expect(exports).toContain('helper')
    expect(resolver.resolve(path.join(nativeRoot, 'src', 'helper.ts'), 'anything')).toBeNull()
  })

  test('handles files with no tree-sitter parser (PHP)', async () => {
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(nativeTmp, 'test-map.json'))
    await resolver.load()

    const content = '<?php function foo() { return bar(); }'
    await resolver.scanFile(path.join(nativeRoot, 'src', 'foo.php'), content, '.php')

    // PHP should be skipped (no tree-sitter parser)
    const stats = resolver.getStats()
    expect(stats.filesWithImports).toBe(0)
  })

  test('deduplicates on re-scan', async () => {
    if (!tsAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver(path.join(nativeTmp, 'test-map.json'))
    await resolver.load()

    // First scan
    const content1 = 'import { foo } from "./bar"\nexport const x = foo()'
    await resolver.scanFile(path.join(nativeRoot, 'src', 'a.ts'), content1, '.ts')
    expect(resolver.resolve(path.join(nativeRoot, 'src', 'a.ts'), 'foo')).not.toBeNull()

    // Second scan with different imports
    const content2 = 'import { baz } from "./qux"\nexport const x = baz()'
    await resolver.scanFile(path.join(nativeRoot, 'src', 'a.ts'), content2, '.ts')

    // Old import should be gone, new one should be there
    expect(resolver.resolve(path.join(nativeRoot, 'src', 'a.ts'), 'foo')).toBeNull()
    expect(resolver.resolve(path.join(nativeRoot, 'src', 'a.ts'), 'baz')).not.toBeNull()
  })
})