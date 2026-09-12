import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { renderMcpSection, upsertMcpSection, writeProjectConfig } from '../src/init-wizard.js'

const options = {
  milvusAddress: 'localhost:19530',
  embeddingEndpoint: 'http://localhost:11434/api/embed',
  embeddingModel: 'nomic-embed-text',
  workspaceRoot: '/repo',
} as const

describe('renderMcpSection', () => {
  it('omits secrets by default', () => {
    const text = renderMcpSection({ ...options })
    expect(text).toContain('[mcp_servers.context-milvus]')
    expect(text).toContain('CONTEXT_MILVUS_WORKSPACE = "/repo"')
    expect(text).not.toContain('MILVUS_TOKEN')
    expect(text).not.toContain('EMBEDDING_API_KEY')
  })

  it('includes secrets only when explicitly provided', () => {
    const text = renderMcpSection({ ...options, milvusToken: 't', embeddingApiKey: 'k' })
    expect(text).toContain('MILVUS_TOKEN = "t"')
    expect(text).toContain('EMBEDDING_API_KEY = "k"')
  })
})

describe('upsertMcpSection', () => {
  it('appends when the section is absent and preserves other content', () => {
    const existing = 'model = "o3"\n'
    const { toml, changed } = upsertMcpSection(existing, { ...options })
    expect(changed).toBe(true)
    expect(toml).toContain('model = "o3"')
    expect(toml).toContain('[mcp_servers.context-milvus]')
  })

  it('replaces only the existing section', () => {
    const existing = [
      'model = "o3"',
      '',
      '[mcp_servers.context-milvus]',
      'command = "old"',
      '',
      '[mcp_servers.other]',
      'command = "keep"',
      '',
    ].join('\n')
    const { toml } = upsertMcpSection(existing, { ...options })
    expect(toml).toContain('model = "o3"')
    expect(toml).toContain('[mcp_servers.other]')
    expect(toml).toContain('command = "keep"')
    expect(toml).not.toContain('command = "old"')
    expect(toml.match(/\[mcp_servers\.context-milvus\]/g)).toHaveLength(1)
  })

  it('is idempotent', () => {
    const first = upsertMcpSection('', { ...options }).toml
    const second = upsertMcpSection(first, { ...options })
    expect(second.changed).toBe(false)
    expect(second.toml).toBe(first)
  })
})

describe('writeProjectConfig', () => {
  it('creates .codex/config.toml and backs up an existing file', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'ctx-init-'))
    try {
      const first = await writeProjectConfig(root, { ...options, workspaceRoot: root })
      expect(existsSync(first.path)).toBe(true)
      expect(first.backup).toBeUndefined()

      // A no-op rerun must not touch the file at all (no write, no backup).
      const noop = await writeProjectConfig(root, { ...options, workspaceRoot: root })
      expect(noop.changed).toBe(false)
      expect(noop.backup).toBeUndefined()

      // A real change backs up the previous file before overwriting it.
      const second = await writeProjectConfig(root, {
        ...options, workspaceRoot: root, embeddingModel: 'bge-m3',
      })
      expect(second.changed).toBe(true)
      expect(second.backup && existsSync(second.backup)).toBe(true)
      const text = await readFile(second.path, 'utf-8')
      expect(text).toContain('[mcp_servers.context-milvus]')
      expect(text).toContain('bge-m3')
      // The backup still holds the previous model.
      expect(await readFile(second.backup!, 'utf-8')).toContain('nomic-embed-text')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
