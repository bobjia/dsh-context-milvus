import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, chmod } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// run-config.ts only touches fs + config, but importing the barrel would pull in
// milvus-service → the SDK. Import the source modules directly instead.
const { deriveRunConfigPath } = await import('../src/config.js')
const { writeRunConfig, readRunConfig } = await import('../src/run-config.js')
const { getConfig } = await import('../src/config.js')

let tmpHome: string
let savedHome: string | undefined

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'runcfg-home-'))
  savedHome = process.env.HOME
  process.env.HOME = tmpHome
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmpHome, { recursive: true, force: true })
})

describe('deriveRunConfigPath', () => {
  it('lives next to the merkle state, with the same name/hash scheme', () => {
    const root = '/home/dev/work/api'
    const dir = path.dirname(deriveRunConfigPath(root))
    expect(dir).toBe(path.join(tmpHome, '.milvus-index'))
    expect(path.basename(deriveRunConfigPath(root))).toMatch(/^run-config-api-[0-9a-f]{16}\.json$/)
  })

  it('isolates two workspaces that share a directory name', () => {
    expect(deriveRunConfigPath('/one/app')).not.toBe(deriveRunConfigPath('/two/app'))
  })
})

describe('writeRunConfig / readRunConfig', () => {
  it('round-trips the resolved config and writes it 0600', async () => {
    const root = path.join(tmpHome, 'proj')
    await mkdir(root, { recursive: true })
    const config = { ...getConfig({}), indexRoot: root }

    const filePath = await writeRunConfig(config)

    expect(filePath).toBe(deriveRunConfigPath(root))
    expect((await stat(filePath)).mode & 0o777).toBe(0o600)

    const back = await readRunConfig(filePath)
    expect(back?.version).toBe(1)
    expect(back?.config.indexRoot).toBe(root)
    expect(back?.config.milvusAddress).toBe(config.milvusAddress)
    expect(typeof back?.generatedAt).toBe('string')
  })

  it('tightens permissions when the file already exists with looser mode', async () => {
    const root = path.join(tmpHome, 'proj2')
    await mkdir(root, { recursive: true })
    const config = { ...getConfig({}), indexRoot: root }
    const filePath = deriveRunConfigPath(root)
    await mkdir(path.dirname(filePath), { recursive: true })
    await writeFile(filePath, '{}', 'utf-8')
    await chmod(filePath, 0o644)

    await writeRunConfig(config)

    expect((await stat(filePath)).mode & 0o777).toBe(0o600)
  })

  it('returns null for a missing, corrupt or wrong-version file', async () => {
    const missing = path.join(tmpHome, 'nope.json')
    expect(await readRunConfig(missing)).toBeNull()

    const corrupt = path.join(tmpHome, 'corrupt.json')
    await writeFile(corrupt, '{ not json', 'utf-8')
    expect(await readRunConfig(corrupt)).toBeNull()

    const wrongVersion = path.join(tmpHome, 'v2.json')
    await writeFile(wrongVersion, JSON.stringify({ version: 2, config: { indexRoot: '/x' } }), 'utf-8')
    expect(await readRunConfig(wrongVersion)).toBeNull()

    const noConfig = path.join(tmpHome, 'noconfig.json')
    await writeFile(noConfig, JSON.stringify({ version: 1 }), 'utf-8')
    expect(await readRunConfig(noConfig)).toBeNull()
  })

  it('does not store anything but JSON (no secrets leak into the path name)', async () => {
    const root = path.join(tmpHome, 'proj3')
    await mkdir(root, { recursive: true })
    const filePath = await writeRunConfig({ ...getConfig({}), indexRoot: root })

    const raw = await readFile(filePath, 'utf-8')
    expect(() => JSON.parse(raw)).not.toThrow()
    expect(path.basename(filePath)).not.toContain('token')
  })
})
