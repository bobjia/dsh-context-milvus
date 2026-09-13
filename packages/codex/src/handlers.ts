import * as path from 'node:path'
import {
  runIndex, getIndexStatus, findCallers, traceChain,
  type SearchResult, type PluginConfig, type HashTracker, type ImportResolver,
  type IndexResult, type IndexStatus, type Logger,
  type CallersResult, type TraceResult, type FindBySymbol, type RelationChunk,
  type AdrBundle, type AdrSearchResult,
} from 'dsh-context-milvus-core'
import { resolveWorkspaceRoot, type WorkspaceSource } from './workspace-resolver.js'

export interface MilvusPort {
  ensureCollection(): Promise<void>
  search(query: string, topK: number, pathPrefix?: string): Promise<SearchResult[]>
  /** Only needed by the ADR tools. */
  ensureAdrCollection?(): Promise<void>
  searchAdr?(query: string, topK: number, filters?: { status?: string; pathPrefix?: string }): Promise<AdrSearchResult[]>
}

export interface HandlerServices {
  root: string
  config: PluginConfig
  milvus: MilvusPort
  tracker: HashTracker
  importResolver: ImportResolver
  adr?: AdrPort
}

/** Structural alias so ADR handlers stay unit-testable with a literal object. */
export type AdrPort = AdrBundle

export type ServiceProvider = (root: string) => Promise<HandlerServices>

export interface SearchCodeArgs {
  query: string
  topK?: number
  path?: string
  pathPrefix?: string
}

export interface IndexCodeArgs {
  mode?: 'full' | 'incremental'
  path?: string
}

export interface IndexStatusArgs {
  path?: string
}

export interface RelatedAdr {
  adrId: string
  title: string
  status: string
}

export async function handleSearchCode(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchCodeArgs,
): Promise<{ root: string; source: WorkspaceSource; results: SearchResult[]; relatedAdrs: RelatedAdr[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  await services.milvus.ensureCollection()

  const scope = args.pathPrefix ? path.join(root, args.pathPrefix) : root
  const topK = args.topK ?? 5
  const results = await services.milvus.search(args.query, topK, scope)
  const relatedAdrs = await relatedAdrsFor(services, root, results, logger)
  logger.debug('search_code done', { root, topK, count: results.length, adrs: relatedAdrs.length })
  return { root, source, results, relatedAdrs }
}

/**
 * Codex has no hook for injecting ADR constraints into a conversation, so the
 * reminder rides along with search results — and only for files an ADR actually
 * covers, so ordinary searches stay byte-identical to the pre-ADR output.
 */
async function relatedAdrsFor(
  services: HandlerServices,
  root: string,
  results: SearchResult[],
  logger: Logger,
): Promise<RelatedAdr[]> {
  const adr = services.adr
  if (!adr) return []

  const ids: string[] = []
  for (const hit of results) {
    const relative = path.isAbsolute(hit.filePath) ? path.relative(root, hit.filePath) : hit.filePath
    // Anchor keys are stored relative to the workspace root, but an index built
    // by another adapter may hold absolute paths; try both.
    for (const key of [relative, hit.filePath]) {
      for (const id of adr.anchorIndex.getAdrsForFile(key)) {
        if (!ids.includes(id)) ids.push(id)
      }
    }
  }
  if (ids.length === 0) return []

  const titles = await adr.titles()
  return ids.map((id) => ({
    adrId: id,
    title: titles.get(id)?.title ?? '',
    status: titles.get(id)?.status ?? 'unknown',
  }))
}

export async function handleIndexCode(
  provider: ServiceProvider,
  logger: Logger,
  args: IndexCodeArgs,
): Promise<{ root: string; source: WorkspaceSource; result: IndexResult }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const mode = args.mode ?? 'incremental'
  const result = await runIndex(services.config, services.milvus as any, services.tracker, {
    mode,
    importResolver: services.importResolver,
    logger,
  })
  logger.info('index_code done', { root, mode, filesIndexed: result.filesIndexed })
  return { root, source, result }
}

export async function handleIndexStatus(
  provider: ServiceProvider,
  logger: Logger,
  args: IndexStatusArgs,
): Promise<{ root: string; source: WorkspaceSource; status: IndexStatus }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  const status = await getIndexStatus(services.config, services.tracker)
  logger.debug('index_status done', { root })
  return { root, source, status }
}

export interface FindCallersArgs {
  symbol: string
  direction?: 'backward' | 'forward'
  maxResults?: number
  sourceFile?: string
  resolve?: boolean
  path?: string
}

export interface TraceChainArgs {
  entry: string
  direction?: 'backward' | 'forward'
  maxDepth?: number
  maxResults?: number
  resolve?: boolean
  path?: string
}

interface RelationPort extends MilvusPort {
  queryByReference(symbol: string, limit?: number, pathPrefix?: string): Promise<SearchResult[]>
  queryByName(name: string, limit?: number, pathPrefix?: string): Promise<SearchResult[]>
}

interface RelationServices extends HandlerServices {
  milvus: RelationPort
}

function toRelationChunk(r: SearchResult): RelationChunk {
  return {
    filePath: r.filePath, content: r.content, startLine: r.startLine,
    endLine: r.endLine, chunkType: r.chunkType, name: r.name,
    references: r.references ?? [],
  }
}

function makeFindBySymbol(services: RelationServices, root: string): FindBySymbol {
  return async (symbol, direction, limit) => {
    const results = direction === 'backward'
      ? await services.milvus.queryByReference(symbol, limit, root)
      : await services.milvus.queryByName(symbol, limit, root)
    return results.map(toRelationChunk)
  }
}

function resolverFor(services: HandlerServices, resolve: boolean) {
  if (!resolve || !services.importResolver.isLoaded()) return undefined
  return {
    resolve: (fp: string, sym: string) => services.importResolver.resolve(fp, sym),
    getExports: (fp: string) => services.importResolver.getExports(fp),
  }
}

export async function handleFindCallers(
  provider: ServiceProvider,
  logger: Logger,
  args: FindCallersArgs,
): Promise<{ root: string; source: WorkspaceSource; result: CallersResult }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = (await provider(root)) as RelationServices
  await services.milvus.ensureCollection()

  const direction = args.direction === 'forward' ? 'forward' : 'backward'
  const resolve = args.resolve !== false
  const sourceFile = args.sourceFile ? path.resolve(root, args.sourceFile) : undefined
  const result = await findCallers(makeFindBySymbol(services, root), args.symbol, direction, {
    maxResults: args.maxResults ?? 20,
    sourceFile,
    resolver: resolverFor(services, resolve),
  })

  if (!resolve || !services.importResolver.isLoaded()) {
    const warning = 'import map 未加载，已降级为名称匹配；运行 index_code 后可精确解析。'
    result.warning = result.warning ? `${result.warning} ${warning}` : warning
  }
  logger.debug('find_callers done', { root, symbol: args.symbol, count: result.chunks.length })
  return { root, source, result }
}

export async function handleTraceCallChain(
  provider: ServiceProvider,
  logger: Logger,
  args: TraceChainArgs,
): Promise<{ root: string; source: WorkspaceSource; result: TraceResult }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = (await provider(root)) as RelationServices
  await services.milvus.ensureCollection()

  const direction = args.direction === 'forward' ? 'forward' : 'backward'
  const resolve = args.resolve !== false
  const result = await traceChain(makeFindBySymbol(services, root), args.entry, {
    direction,
    maxDepth: args.maxDepth ?? 3,
    maxResults: args.maxResults ?? 10,
    resolver: resolverFor(services, resolve),
  })
  logger.debug('trace_call_chain done', { root, entry: args.entry, nodes: result.chain.length })
  return { root, source, result }
}
