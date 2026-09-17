import { jest } from '@jest/globals'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({ connectPromise: Promise.resolve() })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { probeSpecCorpus, exceedsLargeSpecCorpus, LARGE_SPEC_FILE_LIMIT, LARGE_SPEC_BYTE_LIMIT } =
  await import('../src/adr-indexer.js')
const { getConfig } = await import('../src/config.js')

let tmp: string
let savedHome: string | undefined

beforeEach(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'spec-probe-'))
  savedHome = process.env.HOME
  process.env.HOME = tmp
})

afterEach(async () => {
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  await rm(tmp, { recursive: true, force: true })
})

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(tmp, rel)
  await mkdir(path.dirname(full), { recursive: true })
  await writeFile(full, content, 'utf-8')
}

// The engine expects adapters to have ALREADY resolved these roots against
// indexRoot (adr-tools.ts does `path.resolve(indexRoot, config.specRoot)`), so
// the fixture must pass absolute paths. A relative specRoot here would be read
// against process.cwd() — i.e. this repo's own docs/ — instead of the temp dir.
function specCfg() {
  return {
    ...getConfig({}),
    indexRoot: tmp,
    adrRoot: path.join(tmp, 'docs/decisions'),
    specRoot: path.join(tmp, 'docs/superpowers/specs'),
    planRoot: path.join(tmp, 'docs/superpowers/plans'),
  }
}

describe('exceedsLargeSpecCorpus', () => {
  it('uses the production constants by default', () => {
    expect(LARGE_SPEC_FILE_LIMIT).toBe(100)
    expect(LARGE_SPEC_BYTE_LIMIT).toBe(200 * 1024)
  })

  it('does not trigger at exactly the limit and triggers above it', () => {
    expect(exceedsLargeSpecCorpus(100, 0)).toBe(false)
    expect(exceedsLargeSpecCorpus(101, 0)).toBe(true)
    expect(exceedsLargeSpecCorpus(0, 204800)).toBe(false)
    expect(exceedsLargeSpecCorpus(0, 204801)).toBe(true)
  })
})

describe('probeSpecCorpus', () => {
  it('counts spec and plan documents, ignoring everything else', async () => {
    await write('docs/superpowers/specs/2026-01-01-alpha-design.md', 'A')
    await write('docs/superpowers/specs/notes.md', 'not a spec name')
    await write('docs/superpowers/plans/2026-01-02-alpha.md', 'BB')
    await write('docs/superpowers/plans/2026-01-03-beta-design.md', 'not a plan name')
    await write('docs/decisions/ADR-0001-x.md', 'not counted')

    const probe = await probeSpecCorpus(specCfg())

    expect(probe.fileCount).toBe(2)
    expect(probe.totalBytes).toBe(3) // 'A' + 'BB'
    expect(probe.files.some((f) => f.endsWith('2026-01-01-alpha-design.md'))).toBe(true)
    expect(probe.files.some((f) => f.endsWith('2026-01-02-alpha.md'))).toBe(true)

    // Per-file sizes let the caller meter an arbitrary candidate subset without
    // re-reading anything: one entry per counted file, in UTF-8 bytes.
    expect(probe.sizes.size).toBe(2)
    expect(probe.sizes.get(path.join(tmp, 'docs/superpowers/specs/2026-01-01-alpha-design.md'))).toBe(1)
    expect(probe.sizes.get(path.join(tmp, 'docs/superpowers/plans/2026-01-02-alpha.md'))).toBe(2)
  })

  it('reports per-file sizes in UTF-8 bytes, not characters', async () => {
    await write('docs/superpowers/specs/2026-01-01-cjk-design.md', '中文')

    const probe = await probeSpecCorpus(specCfg())

    // 2 characters, 6 bytes
    expect(probe.totalBytes).toBe(6)
    expect(probe.sizes.get(path.join(tmp, 'docs/superpowers/specs/2026-01-01-cjk-design.md'))).toBe(6)
  })

  it('does not recurse into subdirectories (matches runAdrIndex scan)', async () => {
    await write('docs/superpowers/specs/nested/2026-01-01-deep-design.md', 'X')

    const probe = await probeSpecCorpus(specCfg())

    expect(probe.fileCount).toBe(0)
  })

  it('does not count the ADR directory', async () => {
    await write('docs/decisions/ADR-0001-x.md', 'XXXX')

    const probe = await probeSpecCorpus(specCfg())

    expect(probe.fileCount).toBe(0)
    expect(probe.totalBytes).toBe(0)
  })

  it('flags a small corpus when limits are injected', async () => {
    await write('docs/superpowers/specs/2026-01-01-a-design.md', 'X')

    expect((await probeSpecCorpus(specCfg(), { limits: { files: 5 } })).exceedsLargeSpecCorpus).toBe(false)
    expect((await probeSpecCorpus(specCfg(), { limits: { files: 0 } })).exceedsLargeSpecCorpus).toBe(true)
  })
})
