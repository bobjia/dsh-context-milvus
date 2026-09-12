import * as path from 'node:path'
import { deriveMerkleFilePath, deriveAnchorIndexPath, deriveAdrTrackerPath } from '../src/config.js'

/**
 * The legacy DSH wiring derived ADR state paths by string-replacing the merkle
 * path. Existing users already have those files on disk under ~/.milvus-index,
 * so the new helpers must produce byte-identical results. The legacy formula is
 * recomputed here independently: if someone edits the helper bodies, this breaks.
 */
function legacyAnchorPath(root: string): string {
  return deriveMerkleFilePath(root).replace('merkle', 'anchors')
}
function legacyTrackerPath(root: string): string {
  return deriveMerkleFilePath(root).replace('merkle', 'adr-merkle')
}

describe('ADR state path helpers', () => {
  const cases: Array<[string, string]> = [
    ['plain', '/home/dev/work/webhook-service'],
    ['spaces', '/home/dev/My Projects/retail api'],
    ['non-ascii', '/home/dev/工作/中文项目'],
    ['nested', '/a/b/c/d/e/f/g/deep-root-name'],
  ]

  it.each(cases)('anchor path matches the legacy formula (%s)', (_name, root) => {
    expect(deriveAnchorIndexPath(root)).toBe(legacyAnchorPath(root))
  })

  it.each(cases)('tracker path matches the legacy formula (%s)', (_name, root) => {
    expect(deriveAdrTrackerPath(root)).toBe(legacyTrackerPath(root))
  })

  it('names the files anchors-* and adr-merkle-*, next to the merkle state', () => {
    const root = '/home/dev/work/api'
    const dir = path.dirname(deriveMerkleFilePath(root))
    expect(path.dirname(deriveAnchorIndexPath(root))).toBe(dir)
    expect(path.basename(deriveAnchorIndexPath(root))).toMatch(/^anchors-.+-[0-9a-f]{16}\.json$/)
    expect(path.basename(deriveAdrTrackerPath(root))).toMatch(/^adr-merkle-.+-[0-9a-f]{16}\.json$/)
  })

  it('isolates two workspaces with the same directory name', () => {
    const a = deriveAnchorIndexPath('/one/app')
    const b = deriveAnchorIndexPath('/two/app')
    expect(a).not.toBe(b)
  })

  it('does not collide anchor and tracker paths for one root', () => {
    const root = '/home/dev/work/api'
    expect(deriveAnchorIndexPath(root)).not.toBe(deriveAdrTrackerPath(root))
  })
})
