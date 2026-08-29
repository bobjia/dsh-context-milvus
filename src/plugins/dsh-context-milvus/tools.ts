/**
 * DSH tool definitions for dsh-context-milvus.
 *
 * Registers three tools:
 * - search_code: Semantic code search
 * - index_code: Codebase indexing
 * - index_status: Index status check
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MilvusService } from './milvus-service.js'
import type { PluginConfig } from './config.js'
import { deriveMerkleFilePath } from './config.js'
import { HashTracker } from './merkle.js'
import type { IndexResult } from './indexer.js'
import { runIndex, getIndexStatus } from './indexer.js'

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
function formatIndexResult(result: IndexResult): string {
  const lines = [
    `索引完成 (${(result.durationMs / 1000).toFixed(1)}s)`,
    `  - 新增/修改: ${result.filesIndexed} 个文件, ${result.chunksIndexed} 个代码块`,
    `  - 已删除: ${result.filesRemoved} 个文件, ${result.chunksRemoved} 个代码块`,
    `  - 未变更跳过: ${result.filesSkipped} 个文件`,
  ]
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

export function registerTools(
  ctx: Context,
  config: PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
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
            '指定要搜索的路径范围，留空则搜索整个索引库。' +
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

      async execute(params: any) {
        const query = params.query
        const topK = params.topK ?? 5
        const path = params.path as string | undefined

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
            '指定要索引的路径，留空则使用 INDEX_ROOT 环境变量配置的路径。' +
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
          },
          additionalProperties: false,
        },
        render: (_args: any, value: any) => {
          return [{ type: 'text' as const, text: formatIndexResult(value as IndexResult) }]
        },
      },

      async execute(params: any) {
        const mode = (params.mode as 'full' | 'incremental' | undefined) ?? 'incremental'
        const overridePath = params.path as string | undefined

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

        return runIndex(effectiveConfig, milvus, effectiveTracker, { mode })
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
            '指定要查看状态的路径，留空则查看默认工作区的索引状态。' +
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
          return [{ type: 'text' as const, text: lines.join('\n') }]
        },
      },

      async execute(params: any) {
        const overridePath = params.path as string | undefined

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

        return getIndexStatus(effectiveConfig, effectiveTracker)
      },
    }),
  )
}