import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'

export type WorkspaceSource = 'explicit' | 'git' | 'cwd'

export interface WorkspaceResolution {
  root: string
  source: WorkspaceSource
}

export class WorkspaceError extends Error {
  readonly code = 'E_WORKSPACE_NOT_FOUND'
  constructor(message: string) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

/**
 * Resolve the workspace root.
 * Order: explicit path -> nearest ancestor containing .git -> cwd.
 */
export function resolveWorkspaceRoot(
  explicitPath?: string,
  cwd: string = process.cwd(),
): WorkspaceResolution {
  if (explicitPath) {
    const resolved = path.resolve(cwd, explicitPath)
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      throw new WorkspaceError(`工作区路径不存在或不是目录: ${resolved}`)
    }
    return { root: resolved, source: 'explicit' }
  }

  let dir = path.resolve(cwd)
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) {
      return { root: dir, source: 'git' }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return { root: path.resolve(cwd), source: 'cwd' }
}
