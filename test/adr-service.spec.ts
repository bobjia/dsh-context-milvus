import { jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const { AdrService } = await import('../src/plugins/dsh-context-milvus/adr-service.js')

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
})