import {
  getConfig, deriveMerkleFilePath, deriveImportMapFilePath,
  EmbeddingClient, MilvusService, HashTracker, ImportResolver, createAdrBundle,
  type Logger, type PluginConfig, type AdrBundle,
} from 'dsh-context-milvus-core'

export interface WorkspaceServices {
  root: string
  config: PluginConfig
  milvus: MilvusService
  tracker: HashTracker
  importResolver: ImportResolver
  /** Present only when ADR_ENABLED is on. Never connects to Milvus. */
  adr?: AdrBundle
}

export class WorkspaceServiceCache {
  private readonly cache = new Map<string, WorkspaceServices>()

  constructor(private readonly logger: Logger) {}

  async get(root: string): Promise<WorkspaceServices> {
    const existing = this.cache.get(root)
    if (existing) return existing

    const config = getConfig({
      indexRoot: root,
      merkleFilePath: deriveMerkleFilePath(root),
    })
    const embeddingClient = new EmbeddingClient(config.embedding)
    const milvus = new MilvusService({
      address: config.milvusAddress,
      token: config.milvusToken,
      collection: config.milvusCollection,
      dim: config.milvusDim,
      embeddingClient,
      hybridMode: config.hybridMode,
      bm25RrfK: config.bm25RrfK,
      queryExpansion: config.queryExpansion,
      rerankConfig: { enabled: config.rerankEnabled, multiplier: config.rerankMultiplier },
      logger: this.logger,
    })

    const tracker = new HashTracker(config.merkleFilePath)
    await tracker.load().catch(() => {})
    const importResolver = new ImportResolver(deriveImportMapFilePath(root))
    await importResolver.load().catch(() => {})

    // ADR is opt-in per server process. Assembly reads local state files only,
    // so a missing Milvus never breaks tool discovery. createWhenMissing stays
    // at its default: the MCP server must not grow directories in a repo.
    const adr = config.adrEnabled
      ? await createAdrBundle(config, { logger: this.logger })
      : undefined

    const services: WorkspaceServices = { root, config, milvus, tracker, importResolver, adr }
    this.cache.set(root, services)
    this.logger.debug('workspace services ready', { root })
    return services
  }

  size(): number {
    return this.cache.size
  }
}
