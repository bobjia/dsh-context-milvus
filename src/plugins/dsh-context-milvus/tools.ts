/**
 * DSH tool definitions for dsh-context-milvus.
 *
 * Registers three tools:
 * - search_code: Semantic code search
 * - index_code: Codebase indexing
 * - index_status: Index status check
 */

import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MilvusService } from './milvus-service.js'
import type { PluginConfig } from './config.js'
import { deriveMerkleFilePath } from './config.js'
import { HashTracker } from './merkle.js'
import { runIndex, getIndexStatus } from './indexer.js'
import { runAdrIndex, getAdrIndexStatus as getAdrIndexStatusFn } from './adr-indexer.js'
import type { AdrService } from './adr-service.js'
import type { AdrAnchorIndex } from './adr-anchor-index.js'

/** Format search results for model consumption */
function formatSearchResults(value: any[]): string {
  if (value.length === 0) return '未找到匹配的代码片段。'

  const lines = value.map((item: any, i: number) => {
    const lang = item.language ? ` (${item.language})` : ''
    const nameInfo = item.name ? `「${item.name}」` : ''
    return [
      `[结果 ${i + 1}] 文件: ${item.filePath}${lang}, 第 ${item.startLine}-${item.endLine} 行 ${nameInfo}`,
      `相关度: ${item.score.toFixed(4)}`,
      `类型: ${item.chunkType || '未知'}`,
      '内容:',
      '```' + (item.language || ''),
      item.content,
      '```',
    ].join('\n')
  })

  return lines.join('\n---\n')
}

/** Format index result for model consumption */
function formatIndexResult(result: any): string {
  const lines = [
    `索引完成 (${(result.durationMs / 1000).toFixed(1)}s)`,
    `  - 新增/修改: ${result.filesIndexed} 个文件, ${result.chunksIndexed} 个代码块`,
    `  - 已删除: ${result.filesRemoved} 个文件, ${result.chunksRemoved} 个代码块`,
    `  - 未变更跳过: ${result.filesSkipped} 个文件`,
  ]
  if (result.adrFilesIndexed !== undefined) {
    lines.push(`  - ADR 新增/修改: ${result.adrFilesIndexed} 个文件, ${result.adrChunksIndexed} 个代码块`)
  }
  return lines.join('\n')
}

/**
 * Create a hash tracker for a specific workspace path.
 * If the path matches the default config's indexRoot, use the default tracker.
 * Otherwise, create a new tracker with a workspace-specific merkle file.
 *
 * Makes sure the tracker is loaded before returning.
 */
async function createTrackerForPath(
  config: PluginConfig,
  targetPath: string | undefined,
  defaultTracker: HashTracker,
): Promise<HashTracker> {
  if (!targetPath) {
    return defaultTracker
  }

  const normalizedTarget = targetPath.replace(/\/$/, '')
  const normalizedDefault = config.indexRoot.replace(/\/$/, '')

  // If the target path is the same as the default, use the default tracker
  if (normalizedTarget === normalizedDefault) {
    return defaultTracker
  }

  // Create a workspace-specific merkle file path
  const merklePath = deriveMerkleFilePath(targetPath)
  const tracker = new HashTracker(merklePath)
  // Load existing state
  await tracker.load().catch(() => {
    // No state file yet — fresh start
  })
  return tracker
}

/**
 * Register all DSH tools.
 *
 * @param ctx - Cordis context
 * @param resolveConfig - thunk returning the latest PluginConfig; called on
 *   each tool execution so GUI config edits take effect without restart
 * @param milvus - shared Milvus service instance
 * @param tracker - shared default HashTracker instance
 * @param adrOptions - optional ADR services for indexing & status
 */
export function registerTools(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  adrOptions?: {
    service: AdrService
    anchorIndex: AdrAnchorIndex
    adrTracker: HashTracker
  },
): void {
  // ── search_code ───────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'search_code',
      description:
        '在代码库中执行语义搜索。当用户提出模糊的功能需求、' +
        '询问代码逻辑或需要根据自然语言描述查找代码时，使用此工具。',

      parameters: {
        query: {
          type: 'string',
          required: true,
          description: '用户的自然语言查询，例如："处理用户认证的函数在哪里？"',
        },
        topK: {
          type: 'number',
          description: '返回最相关的结果数量，默认为 5。',
        },
        path: {
          type: 'string',
          description:
            '指定要搜索的路径范围，留空则自动使用当前 DSH 工作区目录。' +
            '例如 "/workspace/project" 只搜索该路径下的代码。',
        },
      },

      output: {
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              filePath: { type: 'string' },
              content: { type: 'string' },
              score: { type: 'number' },
              language: { type: 'string' },
              startLine: { type: 'number' },
              endLine: { type: 'number' },
              name: { type: 'string' },
              chunkType: { type: 'string' },
            },
            additionalProperties: false,
          },
        },
        render: (_args: any, value: any) => {
          return [{ type: 'text' as const, text: formatSearchResults(value as any[]) }]
        },
      },

      async execute(params: any, exec?: any) {
        const query = params.query
        const topK = params.topK ?? 5
        // Use explicit path, or the current session's workspace directory
        const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
        const path = params.path ?? sessionCwd ?? undefined

        await milvus.ensureCollection()
        return milvus.search(query, topK, path)
      },
    }),
  )

  // ── index_code ────────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'index_code',
      description:
        '索引代码仓库到向量数据库中。全量模式重新索引所有文件，' +
        '增量模式只索引变更的文件。在首次使用 search_code 前必须先执行一次索引。',

      parameters: {
        mode: {
          type: 'string',
          description:
            '索引模式: "full" 全量重新索引, "incremental" 增量更新（默认）。',
        },
        path: {
          type: 'string',
          description:
            '指定要索引的路径，留空则自动使用当前 DSH 工作区目录。' +
            '不同路径会使用独立的 Merkle 状态文件，互不干扰。',
        },
      },

      output: {
        schema: {
          type: 'object',
          properties: {
            filesIndexed: { type: 'number' },
            chunksIndexed: { type: 'number' },
            filesRemoved: { type: 'number' },
            chunksRemoved: { type: 'number' },
            filesSkipped: { type: 'number' },
            durationMs: { type: 'number' },
            adrFilesIndexed: { type: 'number' },
            adrChunksIndexed: { type: 'number' },
          },
          additionalProperties: false,
        },
        render: (_args: any, value: any) => {
          return [{ type: 'text' as const, text: formatIndexResult(value) }]
        },
      },

      async execute(params: any, exec?: any) {
        const mode = (params.mode as 'full' | 'incremental' | undefined) ?? 'incremental'
        // Use explicit path, or the current session's workspace directory
        const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
        const overridePath = params.path ?? sessionCwd ?? undefined

        // Snapshot latest config at execution time
        const config = resolveConfig()

        // Create effective config with optional path override
        const effectiveConfig = overridePath
          ? {
              ...config,
              indexRoot: overridePath,
              // Derive workspace-specific merkle file path
              merkleFilePath: deriveMerkleFilePath(overridePath),
            }
          : config

        // Use a workspace-specific tracker if the path is different from default
        const effectiveTracker = await createTrackerForPath(config, overridePath, tracker)

        // Progress callback for indexing logs
        const progress = (msg: string) => console.log(`[index_code] ${msg}`)

        const codeResult = await runIndex(effectiveConfig, milvus, effectiveTracker, {
          mode,
          progress,
        })

        // After code indexing, also index ADRs if enabled
        let adrFilesIndexed: number | undefined
        let adrChunksIndexed: number | undefined
        if (adrOptions && effectiveConfig.adrEnabled) {
          const adrConfig = {
            ...effectiveConfig,
            adrRoot: path.resolve(effectiveConfig.indexRoot, effectiveConfig.adrRoot),
            specRoot: path.resolve(effectiveConfig.indexRoot, effectiveConfig.specRoot),
            planRoot: path.resolve(effectiveConfig.indexRoot, effectiveConfig.planRoot),
          }
          const adrResult = await runAdrIndex(
            adrConfig, milvus, adrOptions.adrTracker, adrOptions.anchorIndex,
            { mode, progress },
          )
          adrFilesIndexed = adrResult.filesIndexed
          adrChunksIndexed = adrResult.chunksIndexed
          progress(`  ADR 索引: ${adrResult.filesIndexed} 个文件, ${adrResult.chunksIndexed} 个代码块`)
        }

        return {
          ...codeResult,
          adrFilesIndexed,
          adrChunksIndexed,
        }
      },
    }),
  )

  // ── index_status ──────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'index_status',
      description: '查看当前代码索引的状态，包括已索引文件数、代码块数、最后索引时间。',

      parameters: {
        path: {
          type: 'string',
          description:
            '指定要查看状态的路径，留空则自动使用当前 DSH 工作区目录。' +
            '不同路径的索引状态是独立的。',
        },
      },

      output: {
        schema: {
          type: 'object',
          properties: {
            totalFiles: { type: 'number' },
            totalChunks: { type: 'number' },
            lastIndexed: { type: 'string' },
            indexedExtensions: { type: 'array', items: { type: 'string' } },
            adrTotalAdrs: { type: 'number' },
            adrActiveAdrs: { type: 'number' },
            adrLastIndexed: { type: 'string' },
          },
          additionalProperties: false,
        },
        render: (_args: any, value: any) => {
          const v = value as any
          const lines = [
            '📊 索引状态',
            `  已索引文件: ${v.totalFiles}`,
            `  代码块总数: ${v.totalChunks}`,
            `  最后索引: ${v.lastIndexed || '从未索引'}`,
            `  支持的文件类型: ${(v.indexedExtensions || []).join(', ')}`,
          ]
          if (v.adrTotalAdrs !== undefined) {
            lines.push(
              `  ADR 决策记录: ${v.adrTotalAdrs} 个`,
              `  Active ADR: ${v.adrActiveAdrs} 个`,
              `  ADR 最后索引: ${v.adrLastIndexed || '从未索引'}`,
            )
          }
          return [{ type: 'text' as const, text: lines.join('\n') }]
        },
      },

      async execute(params: any, exec?: any) {
        // Use explicit path, or the current session's workspace directory
        const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
        const overridePath = params.path ?? sessionCwd ?? undefined

        // Snapshot latest config at execution time
        const config = resolveConfig()

        // Use a workspace-specific tracker if a path is provided
        const effectiveTracker = await createTrackerForPath(config, overridePath, tracker)

        // Create effective config with optional path override for status
        const effectiveConfig = overridePath
          ? {
              ...config,
              indexRoot: overridePath,
              merkleFilePath: deriveMerkleFilePath(overridePath),
            }
          : config

        const status = await getIndexStatus(effectiveConfig, effectiveTracker)
        const v = status as any

        // Append ADR status if available
        if (adrOptions && config.adrEnabled) {
          const adrStatus = await getAdrIndexStatusFn(adrOptions.adrTracker, adrOptions.service)
          v.adrTotalAdrs = adrStatus.totalAdrs
          v.adrActiveAdrs = adrStatus.activeAdrs
          v.adrLastIndexed = adrStatus.lastIndexed
        }

        return v
      },
    }),
  )
}
