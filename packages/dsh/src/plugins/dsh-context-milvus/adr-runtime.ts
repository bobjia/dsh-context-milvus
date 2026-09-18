/**
 * 会话级 ADR 运行时（adr-runtime）—— 三个状态对象同根的唯一收敛点。
 *
 * ## 问题
 *
 * DSH 插件启动时按 `config.indexRoot`（默认 `process.cwd()`，即 **DSH 服务进程**的
 * cwd）建出 ADR bundle，但工具执行发生在**会话工作区**里。修复前只有 `AdrService`
 * 会按 `exec.agent.session.header.cwd` 重建，`AdrAnchorIndex` 与 `HashTracker` 仍固定
 * 在启动根。于是 `check_adr_consistency` 读的是启动根的锚点索引、却按会话根解析相对
 * 路径 —— 本机实测 41 条锚点 100% 报失效（36 条来自另一个仓库的 `crates/...`）。
 *
 * ## 关键区分：runtime.root 是 ADR 目录，锚点基准是工作区根
 *
 * `code_anchors[].file` 在生成时就按 **codebase root（工作区根）** 解析
 * （`adr-anchor-generator.ts`），索引里存的是相对**工作区根**的路径。所以：
 *
 * - 索引本身必须按会话根加载（本模块的职责，`root` = `<ws>/docs/decisions`）；
 * - 路径解析基准必须取工作区根（`sessionCwd || config.indexRoot`），**不是**
 *   `runtime.root`。
 *
 * 这两个值必须成对出现，否则又会回到"索引来自 A 根、解析按 B 根"的原 bug。
 *
 * ## 为什么不是 core
 *
 * 这里需要读 `exec.agent.session.header.cwd`（DSH 的会话形状），属于适配器知识；
 * `packages/core/src` 也不允许 import `@deepseek-ai/*`。所以运行时收敛在 dsh 包内，
 * 状态对象的构造与路径推导仍全部来自 `dsh-context-milvus-core`。
 */

import * as path from 'node:path'
import {
  AdrService,
  AdrAnchorIndex,
  HashTracker,
  deriveAnchorIndexPath,
  deriveAdrTrackerPath,
} from 'dsh-context-milvus-core'
import type { PluginConfig } from 'dsh-context-milvus-core'

/**
 * 会话级 ADR 运行时：三者同根，缺一不可。
 *
 * `root` 是 **ADR 目录**（`<workspace>/docs/decisions`），不是工作区根 —— 锚点解析
 * 基准要用 {@link workspaceRootForExec}，见文件头说明。
 */
export interface AdrRuntime {
  /** ADR 目录的绝对路径（`<workspace>/<adrRoot>`）。 */
  root: string
  service: AdrService
  anchorIndex: AdrAnchorIndex
  tracker: HashTracker
}

/** 取出 DSH 会话的工作区目录（工具执行上下文里的 `agent.session.header.cwd`）。 */
function sessionCwdOf(exec?: any): string | undefined {
  return exec?.agent?.session?.header?.cwd as string | undefined
}

/**
 * 锚点路径的**解析基准**：会话工作区根。
 *
 * 与 {@link AdrRuntime.root} 成对使用但**不同**：`code_anchors` 里存的是相对工作区
 * 根的路径，所以 `check_adr_consistency` 必须用它来 `path.resolve`，绝不能用 ADR 目录。
 * 没有会话上下文时回落到 `config.indexRoot`（即改动前的行为，保持向后兼容）。
 */
export function workspaceRootForExec(resolveConfig: () => PluginConfig, exec?: any): string {
  const config = resolveConfig()
  return sessionCwdOf(exec) || config.indexRoot || process.cwd()
}

/**
 * 会话根解析：会话 cwd 优先，否则回落到 config 根。
 *
 * 返回值是 **ADR 目录**（`<ws>/<adrRoot>`），供三个状态对象同根使用。
 */
export function resolveAdrRootForSession(config: PluginConfig, sessionCwd?: string): string {
  const adrRoot = config.adrRoot || 'docs/decisions'
  return sessionCwd
    ? path.resolve(sessionCwd, adrRoot)
    : path.resolve(config.indexRoot, adrRoot)
}

export interface AdrRuntimeResolver {
  /**
   * 启动/配置根的运行时。配置变更时字段被**原地**更新，所以工具/钩子持有的引用
   * 始终有效（与 `applyAdrConfig` 的历史语义一致）。
   */
  readonly startup: AdrRuntime
  /** 取该会话的运行时；按 root 缓存，首次加载状态文件。 */
  forExec(exec?: any): Promise<AdrRuntime>
  /** 同步尽力而为：命中缓存则返回，否则返回 startup（供同步钩子使用）。 */
  peek(exec?: any): AdrRuntime
}

/**
 * 收敛"会话根解析 + 重建三个状态对象"的逻辑。
 *
 * 修复前这段逻辑被复制了三份（`adr-tools.ts` 的 `serviceForExec`、
 * `resolveEffectiveIndexRoot`，以及 `constraint-injector.ts` 的内联版本），每份都只
 * 重建 `AdrService`，于是锚点索引与 tracker 悄悄留在启动根。
 */
export function createAdrRuntimeResolver(opts: {
  resolveConfig: () => PluginConfig
  startup: AdrRuntime
}): AdrRuntimeResolver {
  const { startup } = opts
  const cache = new Map<string, AdrRuntime>()

  /** 该 exec 对应的 ADR 目录（不是工作区根 —— 见文件头说明）。 */
  function adrRootForExec(exec?: any): string {
    const config = opts.resolveConfig()
    return resolveAdrRootForSession(config, sessionCwdOf(exec))
  }

  async function forExec(exec?: any): Promise<AdrRuntime> {
    const root = adrRootForExec(exec)
    // 与会话根一致时直接复用 startup：既避免重复加载状态文件，也保持配置变更
    // 的原地语义（settings 改动后 startup 的字段会被换掉，引用不变）。
    if (root === startup.root) return startup

    const cached = cache.get(root)
    if (cached) return cached

    // 三个状态对象必须同根：createWhenMissing 延续 DSH 既有行为（加载即建 ADR 目录；
    // core 的 createAdrBundle 默认不建目录，只有 DSH 显式建）。
    const service = new AdrService(root, { createWhenMissing: true })
    const anchorIndex = new AdrAnchorIndex(deriveAnchorIndexPath(root))
    const tracker = new HashTracker(deriveAdrTrackerPath(root))

    // 状态文件缺失/损坏 → 退化为空索引，不抛错（与 createAdrBundle 一致）。
    await anchorIndex.load().catch(() => {})
    await tracker.load().catch(() => {})

    const runtime: AdrRuntime = { root, service, anchorIndex, tracker }
    cache.set(root, runtime)
    return runtime
  }

  /**
   * 同步的 best-effort 版本：只做根比对 + 查缓存，**不做 IO**，绝不抛错。
   *
   * 未命中时返回 `startup` —— 对同步钩子（`tools/result`）来说这是可接受的降级：
   * 该钩子只产生一条提示，而缓存通常已被异步的 `agent/pre-step` 钩子预热。
   */
  function peek(exec?: any): AdrRuntime {
    try {
      const root = adrRootForExec(exec)
      if (root === startup.root) return startup
      return cache.get(root) ?? startup
    } catch {
      return startup
    }
  }

  return { startup, forExec, peek }
}
