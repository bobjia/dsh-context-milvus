import { jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const { AdrService } = await import('../src/adr-service.js')

describe('AdrService', () => {
  let tempDir: string
  let adrDir: string
  let service: AdrService

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'adr-svc-'))
    adrDir = path.join(tempDir, 'docs', 'decisions')
    await mkdir(adrDir, { recursive: true })
    service = new AdrService(adrDir)
  })

  it('finds max serial number with no existing ADRs', async () => {
    const serial = await service.findMaxSerial()
    expect(serial).toBe(0)
  })

  it('finds max serial number with existing ADRs', async () => {
    await writeFile(path.join(adrDir, 'ADR-0001-first.md'), '---\nid: ADR-0001-first\n---\nBody')
    await writeFile(path.join(adrDir, 'ADR-0003-third.md'), '---\nid: ADR-0003-third\n---\nBody')
    const serial = await service.findMaxSerial()
    expect(serial).toBe(3)
  })

  it('creates an ADR file with auto-numbering', async () => {
    const result = await service.createAdr({
      title: 'test-decision',
      requirement: 'Test requirement',
      changeType: 'refactor',
    })
    expect(result.id).toBe('ADR-0001-test-decision')
    expect(result.filePath).toContain('ADR-0001-test-decision.md')

    // Verify file exists and has frontmatter
    const content = await readFile(result.filePath, 'utf-8')
    expect(content).toContain('id: ADR-0001-test-decision')
    expect(content).toContain('change_type: refactor')
    expect(content).toContain('requirement_summary: "Test requirement"')
  })

  it('increments ADR serial numbers', async () => {
    await service.createAdr({ title: 'first' })
    const result = await service.createAdr({ title: 'second' })
    expect(result.id).toBe('ADR-0002-second')
  })

  it('lists ADRs with correct info', async () => {
    await service.createAdr({ title: 'first', changeType: 'refactor' })
    await service.createAdr({ title: 'second', changeType: 'new_feature' })
    const list = await service.listAdrs({ status: 'active' })
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('ADR-0001-first')
    expect(list[1].id).toBe('ADR-0002-second')
  })

  it('filters ADRs by status', async () => {
    await service.createAdr({ title: 'active-one' })
    await service.createAdr({ title: 'active-two' })
    const list = await service.listAdrs({ status: 'deprecated' })
    expect(list).toHaveLength(0)
  })

  it('loads an ADR document', async () => {
    await service.createAdr({ title: 'test' })
    const doc = await service.loadAdr('ADR-0001-test')
    expect(doc).not.toBeNull()
    expect(doc!.frontmatter.id).toBe('ADR-0001-test')
  })

  it('loadAdr uses exact id match, not prefix match', async () => {
    await service.createAdr({ title: 'test' })
    // Create a similarly-prefixed file that should NOT match by prefix
    await writeFile(path.join(adrDir, 'ADR-0001-test-2.md'), '---\nid: ADR-0001-test-2\n---\nBody')
    const doc = await service.loadAdr('ADR-0001-test')
    expect(doc).not.toBeNull()
    expect(doc!.filePath).toContain('ADR-0001-test.md')
    expect(doc!.frontmatter.id).toBe('ADR-0001-test')
  })

  it('loadAdr parses ### sub-sections', async () => {
    await service.createAdr({ title: 'test' })
    const doc = await service.loadAdr('ADR-0001-test')
    expect(doc).not.toBeNull()
    // Template has ### 方案A / 方案B sub-headings under 候选方案与权衡
    const keys = Object.keys(doc!.sections)
    expect(keys.some(k => k.includes('方案A'))).toBe(true)
    expect(keys.some(k => k.includes('方案B'))).toBe(true)
  })

  describe('createAdr with a custom body', () => {
    // 缺 frontmatter 的记录会被 parseFrontmatter() 判为 null，对 list_adrs /
    // search_adr / search_adr_by_file / load_constraints 全部隐身。
    // 历史事故：docs/decisions/ADR-0011-tool-output-lossless-json-null-convention.md
    const customBody = '# 标题\n\n正文\n'

    it('still emits frontmatter when a custom body is supplied', async () => {
      const result = await service.createAdr({
        title: 'custom-body',
        requirement: 'Req',
        changeType: 'bugfix',
        content: customBody,
      })
      const raw = await readFile(result.filePath, 'utf-8')
      expect(raw.startsWith('---\n')).toBe(true)
      const doc = await service.loadAdr(result.id)
      expect(doc).not.toBeNull()
      expect(doc!.frontmatter.id).toBe('ADR-0001-custom-body')
      expect(doc!.frontmatter.trigger.change_type).toBe('bugfix')
      expect(doc!.frontmatter.trigger.requirement_summary).toBe('Req')
    })

    it('keeps the custom body verbatim instead of the template body', async () => {
      const result = await service.createAdr({ title: 'body-kept', content: customBody })
      const raw = await readFile(result.filePath, 'utf-8')
      expect(raw).toContain('# 标题\n\n正文')
      expect(raw).not.toContain('### 方案A')
    })

    it('makes the ADR visible to listAdrs', async () => {
      await service.createAdr({ title: 'listed', changeType: 'refactor', content: '## 背景\n\nx\n' })
      const list = await service.listAdrs({ status: 'active' })
      expect(list.map(a => a.id)).toEqual(['ADR-0001-listed'])
    })

    it('strips a caller-supplied frontmatter block instead of writing two', async () => {
      const result = await service.createAdr({
        title: 'pre',
        content: '---\nid: ADR-0009-pre\nstatus: active\n---\n\n# 已有正文\n',
      })
      const raw = await readFile(result.filePath, 'utf-8')
      expect(raw.split('\n').filter(l => l === '---')).toHaveLength(2)
      expect(raw).toContain('# 已有正文')
      const doc = await service.loadAdr(result.id)
      expect(doc!.frontmatter.id).toBe('ADR-0001-pre')
    })
  })

  describe('updateAdr', () => {
    it('updates ADR content with merge', async () => {
      const created = await service.createAdr({ title: 'test' })
      await service.updateAdr('ADR-0001-test', { content: '## New Section\n\nUpdated body\n', merge: true })
      const content = await readFile(created.filePath, 'utf-8')
      expect(content).toContain('Updated body')
    })

    it('updates ADR status in frontmatter', async () => {
      await service.createAdr({ title: 'test' })
      await service.updateAdr('ADR-0001-test', { status: 'superseded' })
      const doc = await service.loadAdr('ADR-0001-test')
      expect(doc!.frontmatter.status).toBe('superseded')
    })

    it('supersedes an ADR by setting supersededBy', async () => {
      await service.createAdr({ title: 'old' })
      await service.updateAdr('ADR-0001-old', { supersededBy: 'ADR-0002-new' })
      const content = await readFile(path.join(adrDir, 'ADR-0001-old.md'), 'utf-8')
      expect(content).toContain('superseded_by: ADR-0002-new')
    })

    it('rejects invalid status', async () => {
      await service.createAdr({ title: 'test' })
      await expect(service.updateAdr('ADR-0001-test', { status: 'bogus' })).rejects.toThrow(/Invalid ADR status/)
    })

    it('rejects update for non-existent ADR', async () => {
      await expect(service.updateAdr('ADR-9999-nope', { status: 'superseded' })).rejects.toThrow(/ADR not found/)
    })
  })
})
describe('AdrService.removeAnchorsForFile', () => {
  async function svcWithAnchors(name: string, anchors: string[]) {
    const dir = await mkdtemp(path.join(tmpdir(), `${name}-`))
    const service = new AdrService(dir)
    const { id, filePath } = await service.createAdr({ title: name, requirement: 'r' })
    const doc = await service.loadAdr(id)
    const list = anchors.map(f => `  - file: ${f}\n    symbols: [x]`).join('\n')
    const body = `---
id: ${id}
type: adr
status: active
created: 2026-09-01
updated: 2026-09-01
author: t
supersedes: null
superseded_by: null
code_anchors:
${list}
trigger:
  change_type: refactor
related_decisions: []
auto_generated: false
---

# 标题

正文
`
    await writeFile(doc!.filePath, body, 'utf-8')
    return { service, id, filePath: doc!.filePath }
  }

  it('drops only the anchors for the given file and keeps the rest', async () => {
    const { service, id } = await svcWithAnchors('strip-me', ['src/keep.ts', 'src/gone.ts'])

    expect(await service.removeAnchorsForFile(id, 'src/gone.ts')).toBe(true)

    const after = await readFile((await service.loadAdr(id))!.filePath, 'utf-8')
    expect(after).toContain('src/keep.ts')
    expect(after).not.toContain('src/gone.ts')
    expect(after.startsWith('---\n')).toBe(true)
    expect(after).toContain('# 标题')
    expect(after).toContain('正文')
  })

  it('returns false when no anchor matches', async () => {
    const { service, id, filePath } = await svcWithAnchors('no-match', ['src/keep.ts'])
    const before = await readFile(filePath, 'utf-8')
    expect(await service.removeAnchorsForFile(id, 'src/never-indexed.ts')).toBe(false)
    expect(await readFile(filePath, 'utf-8')).toBe(before)
  })

  it('returns false for an unknown id', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'strip-unknown-'))
    const service = new AdrService(dir)
    expect(await service.removeAnchorsForFile('ADR-9999-nope', 'src/x.ts')).toBe(false)
  })

  it('leaves no .tmp file behind', async () => {
    const { service, id, filePath } = await svcWithAnchors('tmp-check', ['src/gone.ts'])
    await service.removeAnchorsForFile(id, 'src/gone.ts')
    expect(existsSync(`${filePath}.tmp`)).toBe(false)
  })
})
