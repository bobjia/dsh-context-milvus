/**
 * dsh-context-milvus — DSH plugin entry point
 *
 * A complete index ↔ search plugin for semantic code search via Milvus.
 * - search_code: 语义搜索代码
 * - index_code:  索引代码仓库
 * - index_status: 查看索引状态
 *
 * Configuration (优先顺序: Cordis Config > 默认值):
 *
 *   Cordis Config (通过 DSH GUI 配置面板 / cordis.yml 设置):
 *     milvusAddress, milvusToken, milvusCollection, milvusDim,
 *     embeddingEndpoint, embeddingApiKey, embeddingModel,
 *     indexRoot, indexExtensions, indexIgnoreDirs, hybridMode, bm25RrfK, merkleFilePath,
 *     adrEnabled, adrRoot, adrCollection, adrConstraintReinjectEvery, adrSystemPrompt,
 *     specRoot, planRoot
 *
 *   环境变量 (fallback, ADR 除外):
 *     MILVUS_ADDRESS, MILVUS_TOKEN, MILVUS_COLLECTION, MILVUS_EMBEDDING_DIM,
 *     EMBEDDING_ENDPOINT, EMBEDDING_API_KEY, EMBEDDING_MODEL,
 *     INDEX_ROOT, INDEX_EXTENSIONS, INDEX_IGNORE_DIRS, HYBRID_MODE, BM25_RRF_K, MERKLE_FILE_PATH,
 *     SPEC_ROOT, PLAN_ROOT
 */

import * as path from 'node:path'
import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
// Loads dsh-settings' `Context.settings` service augmentation (types only, erased at runtime).
import type {} from '@deepseek-ai/dsh-settings'
import { getConfig, deriveMerkleFilePath, deriveImportMapFilePath, type CordisConfig, type PluginConfig } from 'dsh-context-milvus-core'
import { MilvusService } from 'dsh-context-milvus-core'
import { HashTracker } from 'dsh-context-milvus-core'
import { EmbeddingClient } from 'dsh-context-milvus-core'
import { ImportResolver } from 'dsh-context-milvus-core'
import { createAdrBundle } from 'dsh-context-milvus-core'
import { registerTools } from './tools.js'
import { registerAdrTools } from './adr-tools.js'
import { runAdrIndex } from 'dsh-context-milvus-core'
import { setupConstraintInjection } from './constraint-injector.js'
import { setupCodeSearchPrompt } from './code-search-prompt.js'
import { createAdrRuntimeResolver, type AdrRuntime } from './adr-runtime.js'

export const name = 'dsh-context-milvus'
export const inject = ['tools']

/** Settings namespace for dsh-context-milvus configuration */
const SETTINGS_NAMESPACE = 'dsh-context-milvus'

/**
 * Config schema for dsh-context-milvus.
 *
 * This schema is used by:
 * - Cordis loader for config validation before the plugin starts
 * - DSH Web GUI (Settings → Plugins) for auto-generated configuration UI
 *
 * Fields with `.role('secret')` are rendered as password inputs in the GUI.
 * Fields with `.description(...)` show tooltips/labels in the GUI.
 */
export const Config = z.object({
  /** Milvus 服务地址 */
  milvusAddress: z.string()
    .default('localhost:19530')
    .description('Milvus 服务地址，例如 localhost:19530'),

  /** Milvus 鉴权 Token (可选) */
  milvusToken: z.string()
    .default('')
    .description('Milvus 鉴权 Token（如不需要可留空）')
    .role('secret'),

  /** Milvus 集合名称 */
  milvusCollection: z.string()
    .default('code_embeddings')
    .description('Milvus 集合名称，用于存储代码向量'),

  /** 向量维度 */
  milvusDim: z.number()
    .default(768)
    .description('Embedding 向量维度（需与模型匹配）'),

  /** Embedding API 地址 */
  embeddingEndpoint: z.string()
    .default('http://localhost:11434/api/embed')
    .description('Embedding API 地址（例如 Ollama: http://localhost:11434/api/embed）'),

  /** Embedding API 密钥 (可选) */
  embeddingApiKey: z.string()
    .default('')
    .description('Embedding API 密钥（如不需要可留空）')
    .role('secret'),

  /** Embedding 模型名称 */
  embeddingModel: z.string()
    .default('nomic-embed-text')
    .description('Embedding 模型名称（例如 Ollama: nomic-embed-text）'),

  /** 代码仓库根路径 */
  indexRoot: z.string()
    .default('')
    .description('代码仓库根路径，用于索引时扫描文件'),

  /** 索引的文件后缀 (逗号分隔) */
  indexExtensions: z.string()
    .default('')
    .description('索引的文件后缀（逗号分隔，留空则索引所有支持的扩展名）'),

  /** 启用混合搜索 (BM25 + 向量) */
  hybridMode: z.boolean()
    .default(true)
    .description('启用混合搜索模式（BM25 全文检索 + 向量语义搜索）'),

  /** BM25 关键词融合 RRF 参数 */
  bm25RrfK: z.number()
    .default(60)
    .description('混合检索 RRF 融合参数 k（默认 60）'),

  /** 分块上下文重叠行数 */
  chunkContextLines: z.number()
    .default(2)
    .description('AST 分块时每个 chunk 前后附加的行数（默认 2，增加可提升检索召回率）')
    .min(0)
    .max(10),

  /** 启用查询扩展 */
  queryExpansion: z.boolean()
    .default(true)
    .description('用代码同义词扩充查询后再 embedding（可提升语义检索命中率）'),

  /** 启用两阶段重排序 */
  rerankEnabled: z.boolean()
    .default(true)
    .description('对检索结果做第二阶段重排序（提升 precision 和 hit@1）'),

  /** 重排序 pool 倍数 */
  rerankMultiplier: z.number()
    .default(3)
    .description('检索时取 topK × multiplier 个结果再重排序（默认 3）')
    .min(1)
    .max(10),

  /** 跳过索引的目录名 (逗号分隔) */
  indexIgnoreDirs: z.string()
    .default('')
    .description('扫描时跳过的目录名（逗号分隔，默认跳过 dist, build, target, __pycache__, vendor 等）'),

  /** Merkle 状态文件路径 */
  merkleFilePath: z.string()
    .default('')
    .description('Merkle 哈希状态文件路径（用于增量索引，留空使用默认位置）'),

  /** 自定义忽略规则 (gitignore 风格) */
  ignorePatterns: z.string()
    .default('')
    .description('自定义 gitignore 风格忽略规则，每行一个模式')
    .role('textarea'),

  /** 启用 ADR 决策记忆功能 */
  adrEnabled: z.boolean()
    .default(false)
    .description('启用 ADR 决策记忆功能（索引/docs/decisions/中的决策记录）'),

  /** ADR 目录路径 */
  adrRoot: z.string()
    .default('docs/decisions')
    .description('ADR 决策记录目录（相对 indexRoot）'),

  /** ADR Milvus 集合名称 */
  adrCollection: z.string()
    .default('adr_embeddings')
    .description('Milvus 集合名称，用于存储 ADR 向量'),

  /** 约束重注入步数间隔 */
  adrConstraintReinjectEvery: z.number()
    .default(0)
    .description('约束重注入步数间隔（每 N 步重新注入 active ADR 约束，0=禁用）')
    .min(0),

  /** 自定义系统提示段落 */
  adrSystemPrompt: z.string()
    .default('')
    .description('自定义 ADR 系统提示段落（留空使用内置模板）')
    .role('textarea'),

  /** 规格文档目录 */
  specRoot: z.string()
    .default('docs/superpowers/specs')
    .description('Brainstorming 规格文档目录（相对 indexRoot）'),

  /** 实现计划目录 */
  planRoot: z.string()
    .default('docs/superpowers/plans')
    .description('实现计划文档目录（相对 indexRoot）'),

  /** 启用本地遥测统计（写入 JSONL，默认关闭） */
  telemetryEnabled: z.boolean()
    .default(false)
    .description('启用本地遥测统计（search_code/index_code/index_status 写入 JSONL，默认关闭）'),

  /** 遥测 JSONL 文件路径 */
  telemetryFile: z.string()
    .default('')
    .description('遥测 JSONL 文件路径（留空使用默认 ~/.milvus-index/telemetry.jsonl）'),
})

/**
 * Fields that are baked into the Milvus/embedding service instances when they
 * are constructed. A change to any of them requires rebuilding those services;
 * every other config field is read per tool execution through the config thunk
 * and therefore takes effect immediately.
 */
function serviceSignature(c: PluginConfig): string {
  return JSON.stringify([
    c.milvusAddress,
    c.milvusToken ?? '',
    c.milvusCollection,
    c.milvusDim,
    c.hybridMode,
    c.bm25RrfK,
    c.queryExpansion,
    c.rerankEnabled,
    c.rerankMultiplier,
    c.embedding.endpoint,
    c.embedding.apiKey ?? '',
    c.embedding.model,
  ])
}

export async function apply(ctx: Context, config?: CordisConfig) {
  // ── Settings registration (mirrors web-search-deepseek pattern) ──────
  // `current` is a thunk so tools always read the latest config after a
  // GUI edit without requiring a plugin reload.
  let current: () => CordisConfig = () => config ?? {}

  // Capture plugin-startup cwd once: tools fall back to it when neither
  // params.path, session.header.cwd, nor config.indexRoot is available.
  const startupCwd = process.cwd()

  // ── Connection services (Milvus + embedding) ─────────────────────────
  // Built from the resolved config and rebuilt on a settings edit whenever one
  // of the construction-time fields changes (see serviceSignature). Tools get
  // `getMilvus` rather than the instance so a rebuild is visible to every
  // subsequent execution.
  let milvus: MilvusService | null = null
  let milvusSignature = ''
  // Bumped on every (re)build; an ensureCollection rejection whose generation
  // is stale lost the race to a settings-driven rebuild and must stay silent —
  // otherwise the startup client's late ECONNREFUSED reports an address the
  // plugin no longer uses. The live generation's own init still reports.
  let milvusGeneration = 0

  const getMilvus = (): MilvusService => {
    if (!milvus) {
      throw new Error('[dsh-context-milvus] MilvusService 尚未初始化')
    }
    return milvus
  }

  /** Build (or rebuild) the Milvus/embedding services. Returns true if rebuilt. */
  function applyServiceConfig(cfg: PluginConfig): boolean {
    const signature = serviceSignature(cfg)
    if (milvus && signature === milvusSignature) return false

    const generation = ++milvusGeneration
    const embeddingClient = new EmbeddingClient(cfg.embedding)
    milvus = new MilvusService({
      address: cfg.milvusAddress,
      token: cfg.milvusToken,
      collection: cfg.milvusCollection,
      dim: cfg.milvusDim,
      embeddingClient,
      hybridMode: cfg.hybridMode,
      bm25RrfK: cfg.bm25RrfK,
      queryExpansion: cfg.queryExpansion,
      rerankConfig: { enabled: cfg.rerankEnabled, multiplier: cfg.rerankMultiplier },
    })
    milvusSignature = signature

    // Try to initialize collection; failure doesn't block tool registration.
    // A rebuild may supersede this client while its connection attempts are
    // still running — leave reporting to the live generation's init.
    milvus.ensureCollection().catch((err: Error) => {
      if (generation !== milvusGeneration) return
      console.warn(
        `[dsh-context-milvus] 集合初始化失败，将在首次使用工具时重试: ${err.message}`,
      )
    })
    return true
  }

  // ── Startup-derived state ────────────────────────────────────────────
  // The Merkle tracker, the cross-file import map and the ADR bundle are all
  // derived from config at load time and carry on-disk state, so each keeps a
  // holder that is refreshed when its inputs change. Tools receive getters (or,
  // for ADR, a stable object whose fields are swapped in place) so a rebuild is
  // visible to every later execution.
  let tracker: HashTracker | null = null
  let trackerPath = ''

  const getTracker = (): HashTracker => {
    if (!tracker) {
      throw new Error('[dsh-context-milvus] HashTracker 尚未初始化')
    }
    return tracker
  }

  /** Build (or rebuild) the default Merkle tracker. Returns true if rebuilt. */
  function applyTrackerConfig(cfg: PluginConfig): boolean {
    if (tracker && cfg.merkleFilePath === trackerPath) return false

    tracker = new HashTracker(cfg.merkleFilePath)
    trackerPath = cfg.merkleFilePath
    // Load Merkle state in the background — a missing state file is a fresh start.
    tracker.load().catch(() => {
      // No state file yet — fresh start
    })
    return true
  }

  let importResolver: ImportResolver | null = null
  let importResolverRoot = ''

  const getImportResolver = (): ImportResolver | undefined => importResolver ?? undefined

  /** Build (or rebuild) the cross-file import map. Returns true if rebuilt. */
  async function applyImportResolverConfig(cfg: PluginConfig): Promise<boolean> {
    if (importResolver && cfg.indexRoot === importResolverRoot) return false

    const resolver = new ImportResolver(deriveImportMapFilePath(cfg.indexRoot))
    await resolver.load().catch(() => {
      // No import map yet — fresh start
    })
    importResolver = resolver
    importResolverRoot = cfg.indexRoot
    return true
  }

  // The ADR bundle (service + anchor index + hash tracker) is derived from
  // indexRoot/adrRoot, and the system prompt section is baked in when the ADR
  // hooks are registered, so both are part of one signature.
  //
  // `adrRuntime` is the **startup** runtime. It is mutated in place by
  // applyAdrConfig() because tools registered earlier hold this exact object;
  // the session-rooted runtimes are derived from it by the resolver below.
  let adrRuntime: AdrRuntime | null = null
  let adrKey = ''

  const getAdrRuntime = (): AdrRuntime => {
    if (!adrRuntime) {
      throw new Error('[dsh-context-milvus] ADR 服务尚未初始化')
    }
    return adrRuntime
  }

  /** ADR inputs that are baked into the bundle or the prompt section. */
  function adrSignature(cfg: PluginConfig): string {
    return JSON.stringify([
      path.resolve(cfg.indexRoot, cfg.adrRoot || 'docs/decisions'),
      cfg.adrSystemPrompt,
    ])
  }

  /** Build (or rebuild) the ADR bundle. Returns true if rebuilt. */
  async function applyAdrConfig(cfg: PluginConfig): Promise<boolean> {
    const key = adrSignature(cfg)
    if (adrRuntime && key === adrKey) return false

    // createWhenMissing: true 延续 DSH 的历史行为 —— 加载插件即建出 ADR 目录。
    // 缺了这个参数就会变成行为变化，因为 core 的 bundle 默认不在用户仓库里建目录。
    const bundle = await createAdrBundle(cfg, { createWhenMissing: true })
    if (adrRuntime) {
      // Mutate in place: tools registered earlier hold this exact object, and the
      // session resolver captured this same reference as its `startup`.
      adrRuntime.root = bundle.adrRoot
      adrRuntime.service = bundle.service
      adrRuntime.anchorIndex = bundle.anchorIndex
      adrRuntime.tracker = bundle.tracker
    } else {
      adrRuntime = {
        root: bundle.adrRoot,
        service: bundle.service,
        anchorIndex: bundle.anchorIndex,
        tracker: bundle.tracker,
      }
    }
    adrKey = key
    return true
  }

  // ADR toggle state: disposers for runtime registration/unregistration
  let adrToolDisposers: (() => void)[] = []
  let constraintDisposer: (() => void) | null = null
  let prevAdrEnabled = false
  // Flipped once the startup services below exist. The settings provider calls
  // onChange() synchronously while attaching — before those services are built
  // — so an early onChange must not touch them.
  let servicesReady = false

  /** Toggle ADR features on/off at runtime without plugin reload. */
  function toggleAdr(enable: boolean): void {
    if (enable && !prevAdrEnabled) {
      // ADR was just enabled — register tools and hooks against the session runtime
      // resolver. The resolver's `startup` is the same object applyAdrConfig()
      // mutates in place, so a settings rebuild stays visible here.
      adrToolDisposers = registerAdrTools(
        ctx, () => getConfig(current()), getMilvus, adrRuntimeResolver,
        { runAdrIndex },
      )
      constraintDisposer = setupConstraintInjection(
        ctx, () => getConfig(current()), adrRuntimeResolver,
      )
      console.log(`[dsh-context-milvus] ADR 决策记忆已启用`)
    } else if (!enable && prevAdrEnabled) {
      // ADR was just disabled — unregister tools and hooks
      adrToolDisposers.forEach(d => d())
      adrToolDisposers = []
      if (constraintDisposer) {
        constraintDisposer()
        constraintDisposer = null
      }
      console.log('[dsh-context-milvus] ADR 决策记忆已禁用')
    }
    prevAdrEnabled = enable
  }

  // Settings commits arrive synchronously, but rebuilding the ADR bundle is
  // async (it reloads on-disk state), so changes are applied in order.
  let configUpdateChain: Promise<void> = Promise.resolve()

  /** Apply a committed settings change to every derived service. */
  function applySettingsChange(): void {
    configUpdateChain = configUpdateChain
      .then(async () => {
        const newConfig = getConfig(current())
        const rebuiltServices = applyServiceConfig(newConfig)
        const rebuiltTracker = applyTrackerConfig(newConfig)
        const rebuiltResolver = await applyImportResolverConfig(newConfig)
        const rebuiltAdr = await applyAdrConfig(newConfig)

        const wasAdrEnabled = prevAdrEnabled
        toggleAdr(newConfig.adrEnabled)
        if (rebuiltAdr && wasAdrEnabled && newConfig.adrEnabled) {
          // ADR tools and hooks captured the previous bundle's instances, so
          // re-register them against the rebuilt one.
          toggleAdr(false)
          toggleAdr(true)
        }

        if (rebuiltServices || rebuiltTracker || rebuiltResolver || rebuiltAdr) {
          console.log('[dsh-context-milvus] 配置已变更，相关服务已重建')
        }
        console.log('[dsh-context-milvus] Configuration updated via settings')
      })
      .catch((err: Error) => {
        console.warn(`[dsh-context-milvus] 配置更新失败: ${err.message}`)
      })
  }

  // dsh-settings ≥0.1.5: the settings section API moved onto the `ctx.settings`
  // service (installSection). It is optional — when no provider is mounted the
  // plugin keeps working off its composition entry config.
  ctx.inject(['settings'], (sctx) => {
    sctx.settings.installSection(ctx, SETTINGS_NAMESPACE, Config, config ?? {}, {
      setSource: (source) => {
        current = source
      },
      onChange: () => {
        // The provider fires onChange() synchronously while attaching, before
        // the startup services below exist; the startup path applies the
        // initial config itself, so ignore that first notification.
        if (!servicesReady) return
        applySettingsChange()
      },
    })
  })

  // Resolve initial config for startup services
  const resolved = getConfig(current())
  applyServiceConfig(resolved)
  applyTrackerConfig(resolved)
  await applyImportResolverConfig(resolved)

  // ── ADR (Decision Memory) services ────────────────────────────────────
  // Always create ADR services at startup so they are available for the
  // main tools (index_code, index_status). ADR tools and constraint
  // injection hooks are registered/unregistered dynamically via toggleAdr().
  await applyAdrConfig(resolved)

  // The session-rooted ADR runtime resolver. It holds the startup runtime by
  // reference; applyAdrConfig() mutates that object's fields in place on a
  // settings edit, so the resolver never needs rebuilding. Sessions whose
  // workspace differs from config.indexRoot get their own three same-rooted
  // state objects (service + anchor index + tracker) — this is the fix for
  // check_adr_consistency reading another root's anchor index.
  const adrRuntimeResolver = createAdrRuntimeResolver({
    resolveConfig: () => getConfig(current()),
    startup: getAdrRuntime(),
  })

  // Startup services now exist, so later settings edits may safely use them.
  servicesReady = true

  // Initial ADR setup — register tools and hooks if enabled at startup.
  // prevAdrEnabled still starts false, so this is a real registration.
  if (resolved.adrEnabled) {
    toggleAdr(true)
    console.log(`[dsh-context-milvus] ADR 决策记忆已加载 (${getAdrRuntime().root})`)
  }

  // Register all tools — pass the config thunk so each tool execution picks up
  // the latest settings without restart, plus getters for every service a
  // settings edit can rebuild. The ADR resolver is a stable object whose
  // `startup` fields are swapped in place; tools check config.adrEnabled at
  // execution time.
  registerTools(
    ctx, () => getConfig(current()), getMilvus, getTracker, getImportResolver, adrRuntimeResolver,
    startupCwd,
  )

  console.log(
    `[dsh-context-milvus] 已加载 (${resolved.indexExtensions.length} 种文件类型, ` +
    `hybrid=${resolved.hybridMode})`,
  )

  setupCodeSearchPrompt(ctx)
}
