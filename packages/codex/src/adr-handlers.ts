import * as path from 'node:path'
import { access } from 'node:fs/promises'
import type {
  AdrSearchResult, AdrListItem, ConstraintSummary, Logger,
  AdrIndexResult, DetectedRef,
} from 'dsh-context-milvus-core'
import {
  findCandidateFiles, previewFrontmatter, generateSpecFrontmatter,
} from 'dsh-context-milvus-core'
import { resolveWorkspaceRoot, type WorkspaceSource } from './workspace-resolver.js'
import { assertWritesEnabled, requireExistingAdr } from './adr-gate.js'
import type { ServiceProvider, HandlerServices, AdrPort } from './handlers.js'

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

export interface CreateAdrArgs {
  title: string
  requirement?: string
  changeType?: string
  supersedes?: string
  content?: string
  path?: string
}

export async function handleCreateAdr(
  provider: ServiceProvider,
  logger: Logger,
  args: CreateAdrArgs,
): Promise<{ root: string; adr: { adrId: string; filePath: string } }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  // Both guards run before anything touches the network or the disk, so a
  // refusal under the default configuration leaves the repository untouched.
  const adr = requireExistingAdr(services.adr)
  assertWritesEnabled('create_adr')

  const created = await adr.service.createAdr({
    title: args.title,
    requirement: args.requirement,
    changeType: args.changeType,
    supersedes: args.supersedes,
    content: args.content,
  })
  await reindex(logger, root, services)
  logger.info('create_adr done', { root, adrId: created.id })
  return { root, adr: { adrId: created.id, filePath: created.filePath } }
}

export interface UpdateAdrArgs {
  adrId: string
  content?: string
  status?: string
  supersededBy?: string
  merge?: boolean
  path?: string
}

export async function handleUpdateAdr(
  provider: ServiceProvider,
  logger: Logger,
  args: UpdateAdrArgs,
): Promise<{ root: string; adr: { adrId: string; filePath: string } }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = requireExistingAdr(services.adr)
  assertWritesEnabled('update_adr')

  const updated = await adr.service.updateAdr(args.adrId, {
    content: args.content,
    status: args.status,
    supersededBy: args.supersededBy,
    merge: args.merge,
  })
  await reindex(logger, root, services)
  logger.info('update_adr done', { root, adrId: updated.id })
  return { root, adr: { adrId: updated.id, filePath: updated.filePath } }
}

/** Incremental ADR re-index; progress goes to the injected logger (stderr). */
async function reindex(
  logger: Logger,
  root: string,
  services: Awaited<ReturnType<ServiceProvider>>,
): Promise<void> {
  const { runAdrIndex } = await import('dsh-context-milvus-core')
  await runAdrIndex(
    services.config, services.milvus as any, services.adr!.tracker, services.adr!.anchorIndex,
    { mode: 'incremental', logger },
  )
  logger.debug('adr re-index requested', { root })
}

export interface CheckAdrConsistencyArgs {
  filePath?: string
  fix?: boolean
  path?: string
}

export interface AdrConsistencyReport {
  staleAnchors: Array<{ adrId: string; file: string; issue: string }>
  uncoveredChanges: Array<{ adrId: string; file: string; status: string }>
  fixedAnchors: Array<{ adrId: string; file: string }>
}

export async function handleCheckAdrConsistency(
  provider: ServiceProvider,
  logger: Logger,
  args: CheckAdrConsistencyArgs,
): Promise<{ root: string; report: AdrConsistencyReport }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = requireExistingAdr(services.adr)
  // fix is the only write in this tool; the read-only report stays available.
  if (args.fix) assertWritesEnabled('check_adr_consistency(fix)')

  const relative = args.filePath
    ? (path.isAbsolute(args.filePath) ? path.relative(root, args.filePath) : args.filePath)
    : undefined

  const report: AdrConsistencyReport = { staleAnchors: [], uncoveredChanges: [], fixedAnchors: [] }
  const all = adr.anchorIndex.getAll()

  for (const [file, ids] of all) {
    if (relative && file !== relative) continue
    try {
      await access(path.resolve(root, file))
    } catch {
      report.staleAnchors.push({ adrId: ids.join(', '), file, issue: '文件已不存在' })
    }
  }

  if (relative && !all.has(relative)) {
    report.uncoveredChanges.push({ adrId: 'N/A', file: relative, status: 'uncovered' })
  }

  if (args.fix && report.staleAnchors.length > 0) {
    for (const anchor of report.staleAnchors) {
      for (const id of anchor.adrId.split(', ').filter(Boolean)) {
        const removed = await stripAnchor(adr, id, anchor.file, logger)
        if (removed) report.fixedAnchors.push({ adrId: id, file: anchor.file })
      }
    }
  }

  logger.info('check_adr_consistency done', {
    root, stale: report.staleAnchors.length, fixed: report.fixedAnchors.length,
  })
  return { root, report }
}

/** The YAML rewrite lives in core so both adapters share one implementation. */
async function stripAnchor(adr: AdrPort, adrId: string, file: string, logger: Logger): Promise<boolean> {
  try {
    return await adr.service.removeAnchorsForFile(adrId, file)
  } catch (err) {
    logger.warn('strip anchor failed', { adrId, file, error: String(err) })
    return false
  }
}

export interface IndexSpecsArgs {
  scanPath?: string
  dryRun?: boolean
  path?: string
}

export interface SpecPreview {
  filePath: string
  adrId: string
  detectedRefs: DetectedRef[]
}

export interface IndexSpecsResult extends AdrIndexResult {
  filesProcessed: number
  anchorsGenerated: number
  dryRun: boolean
  preview: SpecPreview[]
}

export async function handleIndexSpecs(
  provider: ServiceProvider,
  logger: Logger,
  args: IndexSpecsArgs,
): Promise<{ root: string; result: IndexSpecsResult }> {
  const { root } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const adr = requireExistingAdr(services.adr)

  const dryRun = args.dryRun ?? true
  if (!dryRun) assertWritesEnabled('index_specs')

  const specRoot = args.scanPath
    ? path.resolve(root, args.scanPath)
    : path.resolve(root, services.config.specRoot || 'docs/superpowers/specs')
  // Mirrors the DSH tool: an explicit scan path replaces both roots, and an
  // empty plan root means "skip plans".
  const planRoot = args.scanPath
    ? ''
    : path.resolve(root, services.config.planRoot || 'docs/superpowers/plans')

  const candidates: string[] = [...await findCandidateFiles(specRoot, /^\d{4}-\d{2}-\d{2}-.+-design\.md$/)]
  if (planRoot) {
    candidates.push(...await findCandidateFiles(planRoot, /^\d{4}-\d{2}-\d{2}-(?:(?!.*design\.md$).)+\.md$/))
  }

  const preview: SpecPreview[] = []
  let anchorsGenerated = 0
  for (const filePath of candidates) {
    const result = dryRun
      ? await previewFrontmatter(filePath, root)
      : await generateSpecFrontmatter(filePath, root)
    if (!result) continue
    preview.push({ filePath, adrId: result.adrId, detectedRefs: result.detectedRefs })
    anchorsGenerated += result.detectedRefs.length
  }

  const empty: AdrIndexResult = {
    filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0, filesSkipped: 0, durationMs: 0,
  }
  let indexed = empty
  if (!dryRun && candidates.length > 0) {
    const { runAdrIndex } = await import('dsh-context-milvus-core')
    indexed = await runAdrIndex(
      { ...services.config, adrRoot: adr.adrRoot, specRoot, planRoot },
      services.milvus as any, adr.tracker, adr.anchorIndex,
      { mode: 'incremental', logger },
    )
  }

  logger.info('index_specs done', { root, dryRun, filesProcessed: candidates.length })
  return {
    root,
    result: { ...indexed, filesProcessed: candidates.length, anchorsGenerated, dryRun, preview },
  }
}
