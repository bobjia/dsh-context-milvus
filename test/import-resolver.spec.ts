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