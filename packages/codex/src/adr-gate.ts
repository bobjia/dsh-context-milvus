import type { AdrPort } from './handlers.js'

export const ADR_WRITE_ENV = 'CONTEXT_MILVUS_ADR_WRITE'

export type AdrErrorCode = 'E_ADR_WRITE_DISABLED' | 'E_ADR_NOT_INITIALIZED'

export class AdrError extends Error {
  constructor(public readonly code: AdrErrorCode, message: string) {
    super(message)
    this.name = 'AdrError'
  }
}

/** Write tools are opt-in: an autonomous agent must not create documents by surprise. */
export function writesEnabled(): boolean {
  const raw = process.env[ADR_WRITE_ENV] ?? ''
  return /^(1|true|yes|on)$/i.test(raw.trim())
}

export function assertWritesEnabled(action: string): void {
  if (writesEnabled()) return
  throw new AdrError(
    'E_ADR_WRITE_DISABLED',
    `${action} 需要写盘，当前已禁用。设环境变量 ${ADR_WRITE_ENV}=true 并重启 Codex 后可用。`,
  )
}

/**
 * A missing ADR directory is reported, never created: silently growing a
 * docs/decisions tree inside the user's repository is worse than refusing.
 */
export function requireExistingAdr(adr?: AdrPort): AdrPort {
  if (!adr || !adr.exists) {
    throw new AdrError(
      'E_ADR_NOT_INITIALIZED',
      'ADR 目录不存在或不可读，检查 ADR_ROOT（默认 docs/decisions）。',
    )
  }
  return adr
}
