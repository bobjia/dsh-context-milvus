import * as path from 'node:path'
import {
  runIndex, getIndexStatus,
  type SearchResult, type PluginConfig, type HashTracker, type ImportResolver,
  type IndexResult, type IndexStatus, type Logger,
} from 'dsh-context-milvus-core'
import { resolveWorkspaceRoot, type WorkspaceSource } from './workspace-resolver.js'

export interface MilvusPort {
  ensureCollection(): Promise<void>
  search(query: string, topK: number, pathPrefix?: string): Promise<SearchResult[]>
}

export interface HandlerServices {
  root: string
  config: PluginConfig
  milvus: MilvusPort
  tracker: HashTracker
  importResolver: ImportResolver
}

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

export async function handleSearchCode(
  provider: ServiceProvider,
  logger: Logger,
  args: SearchCodeArgs,
): Promise<{ root: string; source: WorkspaceSource; results: SearchResult[] }> {
  const { root, source } = resolveWorkspaceRoot(args.path)
  const services = await provider(root)
  await services.milvus.ensureCollection()

  const scope = args.pathPrefix ? path.join(root, args.pathPrefix) : root
  const topK = args.topK ?? 5
  const results = await services.milvus.search(args.query, topK, scope)
  logger.debug('search_code done', { root, topK, count: results.length })
  return { root, source, results }
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
