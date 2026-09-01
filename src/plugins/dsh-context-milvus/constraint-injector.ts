/**
 * Constraint Injector — system prompt injection + lifecycle hooks
 *
 * Registers a system prompt section with ADR rules, a runtime context provider
 * for active constraints, a pre-step hook for periodic constraint re-injection,
 * and a tools/result hook that warns when the agent touches a code file
 * covered by an ADR's code_anchors.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import * as path from 'node:path'
import type { PluginConfig } from './config.js'
import { AdrService } from './adr-service.js'
import type { AdrAnchorIndex } from './adr-anchor-index.js'
import type { ConstraintSummary } from './types.js'

// systemPrompt, agent/pre-step, and tools/result types are declared in DSH
// framework packages (@deepseek-ai/dsh-system-prompt, @deepseek-ai/dsh-agent)
// not in this project's dependency tree. Cast ctx as any for those accesses.
/** Minimal shape of the framework-provided systemPrompt service. */
interface SystemPromptService {
  section(section: { name: string; order: number; text: string | (() => string) }): void
  context(context: { name: string; order: number; text: string | (() => string) }): void
}

const DEFAULT_SYSTEM_PROMPT = `## 决策记忆系统规则

你是本项目的 AI 编码 Agent。本项目部署了决策因果记忆系统（Decision Causal Memory System）。

### 你必须遵守的规则：

1. **修改有 ADR 覆盖的文件时**：
   - 如修改的文件有 ADR 决策记录覆盖，建议先使用 search_adr_by_file 查询相关 ADR
   - 根据 ADR 约束调整实现方案，避免违反已有决策

2. **执行代码变更时**：
   - 如变更触发 ADR 产出条件（新模块/核心逻辑修改/新依赖/非常规bugfix/架构变更/删除逻辑）
   - 必须使用 create_adr 或 update_adr 工具生成或更新对应的 ADR

3. **创建或更新 ADR 后**：
   - 使用 check_adr_consistency 确认 ADR 与代码一致
   - 确认隐性约束和被否决的反模式字段已填写完整

4. **禁止行为**：
   - ❌ 跳过 ADR 产出（声称"这是小改动"）
   - ❌ 生成只有 WHAT 没有 WHY 的空洞 ADR
   - ❌ 忽略已加载 ADR 中的隐性约束
   - ❌ 重新尝试已被 ADR 否决的方案`

/**
 * Memory cache for constraint summary.
 * Refreshed asynchronously in the pre-step hook; read synchronously by systemPrompt.context().
 */
let constraintCache = ''

/**
 * Per-session state for constraint re-injection tracking.
 */
const sessionState = new WeakMap<object, { stepCount: number; pendingWarnings: string[] }>()

/**
 * Build a short constraint summary from active ADR constraints.
 * Returns a compact format listing ADR ID + constraint counts,
 * not the full constraint text. Users can call load_constraints
 * for full details.
 */
function buildConstraintSummary(constraints: ConstraintSummary[]): string {
  if (constraints.length === 0) return ''
  const parts = constraints.map(c => {
    const items: string[] = []
    if (c.constraints?.length > 0) items.push(`${c.constraints.length} 约束`)
    if (c.hiddenConstraints?.length > 0) items.push(`${c.hiddenConstraints.length} 隐性约束`)
    if (c.rejectedPatterns?.length > 0) items.push(`${c.rejectedPatterns.length} 反模式`)
    return `${c.adrId} (${items.join(', ')})`
  })
  return `当前 Active ADR: ${parts.join('; ')}`
}

/**
 * Set up system prompt injection, constraint re-injection, and file-change tracking.
 */
export function setupConstraintInjection(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  adrService: AdrService,
  anchorIndex: AdrAnchorIndex,
): void {
  const config = resolveConfig()
  if (!config.adrEnabled) return

  const systemPrompt = ctx.get('systemPrompt') as SystemPromptService | undefined

  // ── 1. Register system prompt section ───────────────────────────────────
  if (systemPrompt?.section) {
    const promptText = config.adrSystemPrompt || DEFAULT_SYSTEM_PROMPT
    systemPrompt.section({
      name: 'decision-memory:rules',
      order: 50,
      text: promptText,
    })

    // ── 2. Register runtime context provider (sync — reads cache) ──────────
    systemPrompt.context({
      name: 'decision-memory:active-constraints',
      order: 50,
      text: () => constraintCache,
    })
  }

  // ── 3. Register pre-step hook for constraint re-injection ────────────────
  ;(ctx as any).on('agent/pre-step', async ({ agent, messages, step }: any, next: (...args: any[]) => any) => {
    // Run the next middleware first
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision

    // Get or create per-session state
    const session = agent.session
    let state = sessionState.get(session)
    if (!state) {
      state = { stepCount: 0, pendingWarnings: [] }
      sessionState.set(session, state)
    }
    state.stepCount++

    const reinjectEvery = resolveConfig().adrConstraintReinjectEvery
    const warnings: string[] = [...state.pendingWarnings]
    state.pendingWarnings = []

    // Async refresh constraint cache (no message injection — the system
    // prompt context() provider reads the cache synchronously).
    if (reinjectEvery > 0 && state.stepCount % reinjectEvery === 0) {
      try {
        // Resolve the ADR root against the session workspace when available.
        // ADR files live in the session workspace, not the plugin's startup cwd.
        // When no session cwd is available (e.g. in tests), use the startup service.
        const sessionCwd = agent?.session?.header?.cwd as string | undefined
        let svc = adrService
        if (sessionCwd) {
          const config = resolveConfig()
          const effectiveRoot = path.resolve(sessionCwd, config.adrRoot || 'docs/decisions')
          if (effectiveRoot !== adrService.root) {
            svc = new AdrService(effectiveRoot)
          }
        }

        const constraints = await svc.getActiveConstraints()
        constraintCache = buildConstraintSummary(constraints)
      } catch {
        // Silently handle errors
      }
    }

    // Inject warnings as user-role messages using createUserMessage
    if (warnings.length > 0) {
      const warningText = warnings.join('\n\n')
      const warningMessage = createUserMessage({
        content: [{ type: 'text', text: warningText }],
        source: { kind: 'plugin', plugin: 'dsh-context-milvus' },
      })

      // Find the last claimed message index and insert after it
      // (following the same pattern as dsh-agent-instructions)
      const lastClaimedIndex = decision.messages.findLastIndex(
        (m: any) => messages.includes(m),
      )
      return {
        ...decision,
        messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, warningMessage),
      }
    }

    return decision
  })

  // ── 4. Register tools/result hook for file-change tracking ──────────────
  const FILE_TOOL_NAMES = new Set(['write', 'edit'])
  ;(ctx as any).on('tools/result', (exec: any, result: any) => {
    if (!exec.agent || !result || result.isError) return
    if (!FILE_TOOL_NAMES.has(exec.name)) return

    // Extract file path from arguments
    const filePath = exec.arguments?.file_path as string | undefined
    if (!filePath) return

    // Check if file is in anchor index
    const adrIds = anchorIndex.getAdrsForFile(filePath)
    if (adrIds.length === 0) return

    // Add warning to session state
    const session = exec.agent.session
    let state = sessionState.get(session)
    if (!state) {
      state = { stepCount: 0, pendingWarnings: [] }
      sessionState.set(session, state)
    }
    state.pendingWarnings.push(
      `⚠️ 你修改了文件 ${filePath}，它被以下 ADR 的 code_anchors 覆盖: ${adrIds.join(', ')}。请确认是否需要更新相关 ADR 的约束条件或 code_anchors。`,
    )
  })
}