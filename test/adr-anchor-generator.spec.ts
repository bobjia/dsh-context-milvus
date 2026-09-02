// test/adr-anchor-generator.spec.ts
import { jest } from '@jest/globals'
import { mkdtemp, writeFile, mkdir, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'

const {
  findCandidateFiles,
  detectCodeReferences,
  generateSpecFrontmatter,
  previewFrontmatter,
} = await import('../src/plugins/dsh-context-milvus/adr-anchor-generator.js')

describe('findCandidateFiles', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'find-candidate-'))
  })

  it('returns files without frontmatter matching the regex', async () => {
    await writeFile(path.join(tempDir, 'candidate.md'), '# No frontmatter')
    await writeFile(path.join(tempDir, 'other.txt'), 'Not markdown')

    const results = await findCandidateFiles(tempDir, /\.md$/)
    expect(results).toHaveLength(1)
    expect(results[0]).toBe(path.join(tempDir, 'candidate.md'))
  })

  it('excludes files that already have frontmatter', async () => {
    await writeFile(path.join(tempDir, 'with-fm.md'),
      `---
id: test-001
type: spec
status: active
created: 2026-09-01
updated: 2026-09-01
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: Test
  change_type: architecture
related_decisions: []
auto_generated: false
---
# Has frontmatter`)

    await writeFile(path.join(tempDir, 'no-fm.md'), '# No frontmatter')

    const results = await findCandidateFiles(tempDir, /\.md$/)
    expect(results).toHaveLength(1)
    expect(results[0]).toBe(path.join(tempDir, 'no-fm.md'))
  })

  it('walks nested directories recursively', async () => {
    await mkdir(path.join(tempDir, 'sub'), { recursive: true })
    await writeFile(path.join(tempDir, 'sub', 'nested.md'), '# Nested')
    await writeFile(path.join(tempDir, 'root.md'), '# Root')

    const results = await findCandidateFiles(tempDir, /\.md$/)
    expect(results).toHaveLength(2)
    expect(results).toContain(path.join(tempDir, 'root.md'))
    expect(results).toContain(path.join(tempDir, 'sub', 'nested.md'))
  })

  it('returns empty array for non-existent directory', async () => {
    const results = await findCandidateFiles(path.join(tempDir, 'nope'), /\.md$/)
    expect(results).toEqual([])
  })

  it('returns empty array when no files match the regex', async () => {
    await writeFile(path.join(tempDir, 'candidate.txt'), 'Not markdown')
    const results = await findCandidateFiles(tempDir, /\.md$/)
    expect(results).toEqual([])
  })
})

describe('detectCodeReferences', () => {
  let codebaseRoot: string

  beforeEach(async () => {
    codebaseRoot = await mkdtemp(path.join(tmpdir(), 'codebase-'))
  })

  async function createFile(relPath: string): Promise<void> {
    const fullPath = path.join(codebaseRoot, relPath)
    await mkdir(path.dirname(fullPath), { recursive: true })
    await writeFile(fullPath, '// placeholder')
  }

  // ── Strategy 1: @file annotation detection ──

  it('detects @file: annotations', async () => {
    await createFile('src/foo.ts')
    const content = 'This spec references @file:src/foo.ts in the implementation.'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].file).toBe(path.join(codebaseRoot, 'src/foo.ts'))
    expect(refs[0].symbols).toEqual([])
  })

  it('ignores @file: annotations when the file does not exist', async () => {
    const content = 'Missing file @file:src/missing.ts'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(0)
  })

  // ── Strategy 1: @symbol annotation detection ──

  it('associates @symbol: annotations with preceding @file: annotation', async () => {
    await createFile('src/types.ts')
    const content = 'The key type is @file:src/types.ts with @symbol:User and @symbol:Admin'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].symbols).toContain('User')
    expect(refs[0].symbols).toContain('Admin')
  })

  it('associates @symbol: with nearest preceding @file: across lines', async () => {
    await createFile('src/foo.ts')
    await createFile('src/bar.ts')
    const content = [
      'First file: @file:src/foo.ts with @symbol:FooSym',
      'Second file: @file:src/bar.ts with @symbol:BarSym',
    ].join('\n')
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(2)

    const fooRef = refs.find(r => r.file === path.join(codebaseRoot, 'src/foo.ts'))
    const barRef = refs.find(r => r.file === path.join(codebaseRoot, 'src/bar.ts'))
    expect(fooRef).toBeDefined()
    expect(barRef).toBeDefined()
    expect(fooRef!.symbols).toContain('FooSym')
    expect(barRef!.symbols).toContain('BarSym')
  })

  // ── Strategy 2: Path pattern matching ──

  it('detects src/ path patterns', async () => {
    await createFile('src/router.ts')
    await createFile('test/router.spec.ts')
    const content = 'The router is defined in src/router.ts and tests in test/router.spec.ts'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(2)
    const filePaths = refs.map(r => r.file)
    expect(filePaths).toContain(path.join(codebaseRoot, 'src/router.ts'))
    expect(filePaths).toContain(path.join(codebaseRoot, 'test/router.spec.ts'))
  })

  it('ignores path patterns when the file does not exist', async () => {
    const content = 'Some path src/missing.ts'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(0)
  })

  // ── Strategy 3: Backtick-quoted symbols ──

  it('associates backtick-quoted symbols with preceding file paths', async () => {
    await createFile('src/button.ts')
    const content = 'In src/button.ts the component `Button` is defined.'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].symbols).toContain('Button')
    expect(refs[0].file).toBe(path.join(codebaseRoot, 'src/button.ts'))
  })

  it('associates multiple backtick symbols with the same file', async () => {
    await createFile('src/utils.ts')
    const content = [
      'In src/utils.ts the `formatDate` function and',
      'the `parseInput` helper are defined.',
    ].join('\n')
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].symbols).toContain('formatDate')
    expect(refs[0].symbols).toContain('parseInput')
  })

  // ── Trailing-punctuation handling ──

  it('strips trailing period from @file: annotations', async () => {
    await createFile('src/foo.ts')
    const content = 'See @file:src/foo.ts. for details'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].file).toBe(path.join(codebaseRoot, 'src/foo.ts'))
  })

  it('strips trailing period from path patterns', async () => {
    await createFile('src/foo.ts')
    const content = 'check src/foo.ts.'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].file).toBe(path.join(codebaseRoot, 'src/foo.ts'))
  })

  it('strips trailing period from @symbol: annotations', async () => {
    await createFile('src/types.ts')
    const content = 'the @file:src/types.ts @symbol:FooBar. function'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].symbols).toContain('FooBar')
  })

  it('strips trailing closing paren from @file: annotations', async () => {
    await createFile('src/bar.ts')
    const content = 'See @file:src/bar.ts) for details'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].file).toBe(path.join(codebaseRoot, 'src/bar.ts'))
  })

  it('strips trailing comma from @file: annotations', async () => {
    await createFile('src/baz.ts')
    const content = 'Files like @file:src/baz.ts, are common.'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].file).toBe(path.join(codebaseRoot, 'src/baz.ts'))
  })

  it('strips trailing comma from path patterns', async () => {
    await createFile('src/qux.ts')
    const content = 'Import from src/qux.ts, then use it.'
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    expect(refs[0].file).toBe(path.join(codebaseRoot, 'src/qux.ts'))
  })

  // ── Cumulative strategies + deduplication ──

  it('deduplicates by file path and merges symbols', async () => {
    await createFile('src/core.ts')
    const content = [
      '@file:src/core.ts provides @symbol:CoreClass',
      'In src/core.ts the `CoreClass` is used',
      'Also see src/core.ts for `init`',
    ].join('\n')
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    // Should have unique symbols from all strategies
    const syms = refs[0].symbols
    expect(syms).toContain('CoreClass') // from @symbol:
    expect(syms).toContain('init')       // from backtick
  })

  it('records line numbers for each reference', async () => {
    await createFile('src/foo.ts')
    const content = [
      'Line one with @file:src/foo.ts',
      'Line two has nothing',
      'Line three with `bar` referencing src/foo.ts',
    ].join('\n')
    const refs = detectCodeReferences(content, codebaseRoot)
    expect(refs).toHaveLength(1)
    // Line range should cover all matches: line 1 (file + symbol==null) and line 3 (symbol bar)
    expect(refs[0].lines[0]).toBeLessThanOrEqual(1)
    expect(refs[0].lines[1]).toBeGreaterThanOrEqual(3)
  })
})

describe('generateSpecFrontmatter', () => {
  let tempDir: string
  let codebaseRoot: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'gen-fm-'))
    codebaseRoot = await mkdtemp(path.join(tmpdir(), 'gen-code-'))
  })

  it('generates frontmatter for a spec file with code references', async () => {
    await createFile(path.join(codebaseRoot, 'src/core.ts'), '// core')
    const specPath = path.join(tempDir, '2026-09-01-lazy-eval-design.md')
    await writeFile(specPath, '# Lazy eval\n\nThis references @file:src/core.ts\n')

    const result = await generateSpecFrontmatter(specPath, codebaseRoot)
    expect(result).not.toBeNull()
    expect(result!.generated).toBe(true)
    expect(result!.adrId).toMatch(/^SPEC-/)
    expect(result!.detectedRefs).toHaveLength(1)
    expect(result!.detectedRefs[0].file).toBe(path.join(codebaseRoot, 'src/core.ts'))

    // Verify file was written with frontmatter
    const content = await readFile(specPath, 'utf-8')
    const { parseFrontmatter } = await import('../src/plugins/dsh-context-milvus/adr-frontmatter.js')
    const fm = parseFrontmatter(content)
    expect(fm).not.toBeNull()
    expect(fm!.id).toBe(result!.adrId)
    expect(fm!.type).toBe('spec')
    expect(fm!.status).toBe('active')
    expect(fm!.auto_generated).toBe(true)
    expect(fm!.code_anchors).toHaveLength(1)
    expect(fm!.code_anchors[0].file).toBe(path.join(codebaseRoot, 'src/core.ts'))
    expect(fm!.code_anchors[0].symbols).toEqual([])
    expect(fm!.trigger.requirement_summary).toBe('lazy eval design')
  })

  it('generates frontmatter with type plan for non-design files', async () => {
    const planPath = path.join(tempDir, '2026-09-01-my-plan.md')
    await writeFile(planPath, '# My plan')

    const result = await generateSpecFrontmatter(planPath, codebaseRoot)
    expect(result).not.toBeNull()
    expect(result!.adrId).toMatch(/^PLAN-/)
    expect(result!.generated).toBe(true)
  })

  it('returns null for files that already have frontmatter', async () => {
    const specPath = path.join(tempDir, 'existing-design.md')
    await writeFile(specPath,
      `---
id: SPEC-2026-09-01-existing
type: spec
status: active
created: 2026-09-01
updated: 2026-09-01
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: Test
  change_type: architecture
related_decisions: []
auto_generated: true
---
# Existing spec`)

    const result = await generateSpecFrontmatter(specPath, codebaseRoot)
    expect(result).toBeNull()
  })

  it('performs atomic write (tmp file is cleaned up)', async () => {
    const specPath = path.join(tempDir, 'atomic-design.md')
    await writeFile(specPath, '# Atomic test')

    const result = await generateSpecFrontmatter(specPath, codebaseRoot)
    expect(result).not.toBeNull()
    expect(result!.generated).toBe(true)

    // Temp file should be cleaned up
    expect(existsSync(`${specPath}.tmp`)).toBe(false)
    // Original file should exist and have frontmatter
    expect(existsSync(specPath)).toBe(true)
    const content = await readFile(specPath, 'utf-8')
    expect(content.startsWith('---\n')).toBe(true)
  })
})

describe('previewFrontmatter', () => {
  let tempDir: string
  let codebaseRoot: string

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'preview-'))
    codebaseRoot = await mkdtemp(path.join(tmpdir(), 'preview-code-'))
  })

  it('returns detected refs without writing to disk', async () => {
    await createFile(path.join(codebaseRoot, 'src/foo.ts'), '// foo')
    const specPath = path.join(tempDir, '2026-09-01-preview-design.md')
    await writeFile(specPath, '# Preview\n\n@file:src/foo.ts\n')

    const result = await previewFrontmatter(specPath, codebaseRoot)
    expect(result).not.toBeNull()
    expect(result!.generated).toBe(false)
    expect(result!.adrId).toMatch(/^SPEC-/)
    expect(result!.detectedRefs).toHaveLength(1)

    // File should NOT have frontmatter
    const content = await readFile(specPath, 'utf-8')
    const { parseFrontmatter } = await import('../src/plugins/dsh-context-milvus/adr-frontmatter.js')
    expect(parseFrontmatter(content)).toBeNull()
  })

  it('returns null for files that already have frontmatter', async () => {
    const specPath = path.join(tempDir, 'existing-design.md')
    await writeFile(specPath,
      `---
id: SPEC-2026-09-01-existing
type: spec
status: active
created: 2026-09-01
updated: 2026-09-01
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: Test
  change_type: architecture
related_decisions: []
auto_generated: true
---
# Existing spec`)

    const result = await previewFrontmatter(specPath, codebaseRoot)
    expect(result).toBeNull()
  })

  it('computes adrId and docType correctly for plan files', async () => {
    const planPath = path.join(tempDir, '2026-09-01-preview-plan.md')
    await writeFile(planPath, '# Plan')

    const result = await previewFrontmatter(planPath, codebaseRoot)
    expect(result).not.toBeNull()
    expect(result!.adrId).toMatch(/^PLAN-/)
    expect(result!.generated).toBe(false)
  })
})

// Helper
async function createFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true })
  await writeFile(filePath, content)
}