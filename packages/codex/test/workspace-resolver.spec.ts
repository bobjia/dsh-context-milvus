import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { resolveWorkspaceRoot, WorkspaceError } from '../src/workspace-resolver.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ctx-ws-'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('resolveWorkspaceRoot', () => {
  it('prefers an explicit path', async () => {
    const target = path.join(root, 'proj')
    await mkdir(path.join(target, '.git'), { recursive: true })
    const result = resolveWorkspaceRoot(target, root)
    expect(result).toEqual({ root: target, source: 'explicit' })
  })

  it('throws E_WORKSPACE_NOT_FOUND for a missing explicit path', () => {
    expect(() => resolveWorkspaceRoot(path.join(root, 'nope'), root))
      .toThrow(WorkspaceError)
  })

  it('walks up to the nearest .git directory', async () => {
    const repo = path.join(root, 'repo')
    const nested = path.join(repo, 'a', 'b')
    await mkdir(path.join(repo, '.git'), { recursive: true })
    await mkdir(nested, { recursive: true })
    expect(resolveWorkspaceRoot(undefined, nested)).toEqual({ root: repo, source: 'git' })
  })

  it('treats a .git file (worktree) as a repository marker', async () => {
    const repo = path.join(root, 'wt')
    await mkdir(repo, { recursive: true })
    await writeFile(path.join(repo, '.git'), 'gitdir: /elsewhere\n', 'utf-8')
    expect(resolveWorkspaceRoot(undefined, repo)).toEqual({ root: repo, source: 'git' })
  })

  it('falls back to cwd when no .git exists', async () => {
    const plain = path.join(root, 'plain')
    await mkdir(plain, { recursive: true })
    expect(resolveWorkspaceRoot(undefined, plain)).toEqual({ root: plain, source: 'cwd' })
  })
})
