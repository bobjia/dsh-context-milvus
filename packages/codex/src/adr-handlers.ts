import * as path from 'node:path'
import type {
  AdrSearchResult, AdrListItem, ConstraintSummary, Logger,
} from 'dsh-context-milvus-core'
import { resolveWorkspaceRoot, type WorkspaceSource } from './workspace-resolver.js'
import type { ServiceProvider, AdrPort } from './handlers.js'

/** ADR tools always need a bundle; the server only registers them when enabled. */
function needAdr(services: { adr?: AdrPort }): AdrPort {
  if (!services.adr) {
    throw new Error('ADR 决策记忆未启用：设 ADR_ENABLED=true 后重启 Codex')
  }
  return services.adr
}

export interface SearchAdrArgs {
  query: string
  status?: string
  topK?: number
  pathPrefix?: string
  path?: string
}

export async function handleSearchAdr(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchAdrArgs,
): Promise<{ root: string; source: WorkspaceSource; results: AdrSearchResult[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  needAdr(services)
  if (!services.milvus.ensureAdrCollection || !services.milvus.searchAdr) {
    throw new Error('Milvus 服务不支持 ADR 检索')
  }
  await services.milvus.ensureAdrCollection()

  const filters: { status?: string; pathPrefix?: string } = {}
  if (args.status && args.status !== 'all') filters.status = args.status
  if (args.pathPrefix) filters.pathPrefix = args.pathPrefix

  const topK = args.topK ?? 5
  const results = await services.milvus.searchAdr(
    args.query, topK, Object.keys(filters).length ? filters : undefined,
  )
  logger.debug('search_adr done', { root, topK, count: results.length })
  return { root, source, results }
}

export interface SearchAdrByFileArgs {
  filePath: string
  status?: string
  path?: string
}

export interface AdrByFileEntry {
  adrId: string
  filePath: string
  status: string
  summary: string
}

export async function handleSearchAdrByFile(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchAdrByFileArgs,
): Promise<{ root: string; source: WorkspaceSource; adrs: AdrByFileEntry[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = needAdr(services)

  // The anchor index keys are relative to the workspace root, exactly like
  // find_callers' sourceFile handling — accept either form from the caller.
  const relative = path.isAbsolute(args.filePath)
    ? path.relative(root, args.filePath)
    : args.filePath

  const adrs: AdrByFileEntry[] = []
  for (const id of adr.anchorIndex.getAdrsForFile(relative)) {
    const doc = await adr.service.loadAdr(id)
    if (!doc) continue
    if (args.status && args.status !== 'all' && doc.frontmatter.status !== args.status) continue
    const firstSection = Object.values(doc.sections)[0] || ''
    adrs.push({
      adrId: doc.frontmatter.id,
      filePath: doc.filePath,
      status: doc.frontmatter.status,
      summary: firstSection.slice(0, 200),
    })
  }
  logger.debug('search_adr_by_file done', { root, relative, count: adrs.length })
  return { root, source, adrs }
}

export interface ListAdrsArgs {
  status?: string
  changeType?: string
  limit?: number
  path?: string
}

export async function handleListAdrs(
  provider: ServiceProvider,
  logger: Logger,
  args: ListAdrsArgs,
): Promise<{ root: string; source: WorkspaceSource; adrs: AdrListItem[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = needAdr(services)
  const adrs = await adr.service.listAdrs({
    status: args.status ?? 'active',
    changeType: args.changeType,
    limit: args.limit ?? 100,
  })
  logger.debug('list_adrs done', { root, count: adrs.length })
  return { root, source, adrs }
}

export interface LoadConstraintsArgs {
  format?: 'summary' | 'full'
  adrIds?: string
  path?: string
}

export interface ConstraintPayload {
  adrId: string
  adrTitle: string
  constraints: string[]
  rejectedPatterns: string[]
  hiddenConstraints?: ConstraintSummary['hiddenConstraints']
}

export async function handleLoadConstraints(
  provider: ServiceProvider,
  logger: Logger,
  args: LoadConstraintsArgs,
): Promise<{ root: string; source: WorkspaceSource; constraints: ConstraintPayload[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = needAdr(services)
  const all = await adr.service.getActiveConstraints()

  let picked = all
  if (args.adrIds) {
    const ids = args.adrIds.split(',').map((s) => s.trim()).filter(Boolean)
    picked = all.filter((c) => ids.includes(c.adrId))
  }
  const full = (args.format ?? 'summary') === 'full'
  const constraints: ConstraintPayload[] = picked.map((c) => ({
    adrId: c.adrId,
    adrTitle: c.adrTitle,
    constraints: c.constraints,
    rejectedPatterns: c.rejectedPatterns,
    ...(full ? { hiddenConstraints: c.hiddenConstraints } : {}),
  }))
  logger.debug('load_constraints done', { root, count: constraints.length, format: full ? 'full' : 'summary' })
  return { root, source, constraints }
}
