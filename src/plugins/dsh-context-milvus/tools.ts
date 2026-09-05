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
import { deriveMerkleFilePath, deriveImportMapFilePath } from './config.js'
import { HashTracker } from './merkle.js'
import { ImportResolver } from './import-resolver.js'
import { runIndex, getIndexStatus } from './indexer.js'
import { runAdrIndex, getAdrIndexStatus as getAdrIndexStatusFn } from './adr-indexer.js'
import type { AdrService } from './adr-service.js'
import type { AdrAnchorIndex } from './adr-anchor-index.js'
import { findCallers, traceChain } from './code-relations.js'
import type { FindBySymbol } from './code-relations.js'
import { createTelemetry, sanitizeQuery } from './telemetry.js'

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
 * @param importResolver - optional ImportResolver for cross-file import/export analysis
 * @param adrOptions - optional ADR services for indexing & status
 */
export function registerTools(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  importResolver?: ImportResolver,
  adrOptions?: {
    service: AdrService
    anchorIndex: AdrAnchorIndex
    adrTracker: HashTracker
  },
): void {
  // 本地遥测（opt-in）：每次调用实时解析配置
  const telemetry = createTelemetry(() => {
    const c = resolveConfig()
    return { telemetryEnabled: c.telemetryEnabled, telemetryFile: c.telemetryFile }
  })

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
        const started = Date.now()
        const query = params.query
        const topK = params.topK ?? 5
        // Use explicit path, or the current session's workspace directory
        const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
        const path = params.path ?? sessionCwd ?? undefined

        await milvus.ensureCollection()
        const results = await milvus.search(query, topK, path)
        telemetry.log({
          ts: new Date().toISOString(),
          tool: 'search_code',
          query: sanitizeQuery(query),
          topK,
          path: path ?? '',
          resultCount: results.length,
          topScore: results.length > 0 ? results[0].score : null,
          durationMs: Date.now() - started,
        })
        return results
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

        // Use a workspace-specific import resolver if the path is different from default
        const effectiveImportResolver = overridePath
          ? new ImportResolver(deriveImportMapFilePath(overridePath))
          : importResolver
        if (overridePath && effectiveImportResolver) {
          await effectiveImportResolver.load().catch(() => {
            // No import map yet — fresh start
          })
        }

        // Progress callback for indexing logs
        const progress = (msg: string) => console.log(`[index_code] ${msg}`)

        const codeResult = await runIndex(effectiveConfig, milvus, effectiveTracker, {
          mode,
          progress,
          importResolver: effectiveImportResolver,
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

        telemetry.log({
          ts: new Date().toISOString(),
          tool: 'index_code',
          mode,
          path: effectiveConfig.indexRoot,
          filesIndexed: codeResult.filesIndexed,
          chunksIndexed: codeResult.chunksIndexed,
          filesSkipped: codeResult.filesSkipped,
          durationMs: codeResult.durationMs,
        })

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

        telemetry.log({
          ts: new Date().toISOString(),
          tool: 'index_status',
          path: effectiveConfig.indexRoot,
          totalFiles: v.totalFiles,
          totalChunks: v.totalChunks,
          lastIndexed: v.lastIndexed ?? '',
        })

        return v
      },
    }),
  )

  // ── find_callers ────────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'find_callers',
      description:
        '查找代码中引用某个符号（函数/变量/类）的所有位置。' +
        '用于代码修改影响分析：改了某个函数，看它被哪些地方调用了。' +
        'direction=backward 找引用者（影响面），direction=forward 找被调用者（依赖面）。',

      parameters: {
        symbol: {
          type: 'string',
          required: true,
          description: '要查找的符号名（函数名、变量名、类名）',
        },
        direction: {
          type: 'string',
          description: 'backward=谁引用了我（影响面，默认）；forward=我引用了谁（依赖面）',
        },
        maxResults: {
          type: 'number',
          description: '最大返回结果数，默认 20',
        },
        sourceFile: {
          type: 'string',
          description: '限定定义文件路径（显式消歧，只返回从该文件导入该符号的调用者）',
        },
        resolve: {
          type: 'boolean',
          description: '是否启用 import 解析（默认 true，设为 false 回退到 V1 名称匹配）',
        },
      },

      output: {
        schema: {
          type: 'object',
          properties: {
            chunks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  filePath: { type: 'string' },
                  content: { type: 'string' },
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                  chunkType: { type: 'string' },
                  name: { type: 'string' },
                  references: { type: 'array', items: { type: 'string' } },
                  resolution: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['resolved', 'local', 'unresolved'] },
                      targetFile: { type: 'string' },
                      exportedAs: { type: 'string' },
                    },
                    additionalProperties: false,
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        render: (_args: any, value: any) => {
          const result = value as { chunks: any[]; warning?: string }
          if (result.chunks.length === 0) {
            const text = result.warning
              ? `未找到引用该符号的代码。${result.warning}`
              : '未找到引用该符号的代码。'
            return [{ type: 'text' as const, text }]
          }
          const lines = result.chunks.map((c: any, i: number) => {
            return [
              `[${i + 1}] ${c.filePath}:${c.startLine}-${c.endLine}`,
              `    ${c.chunkType}「${c.name}」`,
              c.content.length > 200 ? c.content.slice(0, 200) + '...' : c.content,
            ].join('\n')
          })
          const header = result.warning
            ? `找到 ${result.chunks.length} 个引用位置：${result.warning}\n\n`
            : `找到 ${result.chunks.length} 个引用位置：\n\n`
          return [{ type: 'text' as const, text: header + lines.join('\n---\n') }]
        },
      },

      async execute(params: any, exec?: any) {
        await milvus.ensureCollection()
        const direction = params.direction === 'forward' ? 'forward' as const : 'backward' as const
        const maxResults = params.maxResults ?? 20
        const sourceFile = params.sourceFile ? path.resolve(params.sourceFile as string) : undefined
        const resolve = params.resolve !== false

        // Load import resolver if resolve is enabled
        const resolver = resolve && importResolver?.isLoaded() ? importResolver : undefined

        // Warn when sourceFile is provided but resolver is not available
        let sourceFileWarning = ''
        if (params.sourceFile && !resolver) {
          sourceFileWarning = '（注意：import map 未加载，sourceFile 参数已降级为按文件路径过滤）'
        }

        const findBySymbol: FindBySymbol = async (symbol, dir, limit) => {
          if (dir === 'backward') {
            const results = await milvus.queryByReference(symbol, limit)
            return results.map(r => ({
              filePath: r.filePath,
              content: r.content,
              startLine: r.startLine,
              endLine: r.endLine,
              chunkType: r.chunkType,
              name: r.name,
            }))
          } else {
            // Forward: find the definition, then collect its references
            const results = await milvus.queryByName(symbol, limit)
            // Return the definition chunks with their references (callees)
            return results.map(r => ({
              filePath: r.filePath,
              content: r.content,
              startLine: r.startLine,
              endLine: r.endLine,
              chunkType: r.chunkType,
              name: r.name,
              references: (r as any).references ?? [],
            }))
          }
        }

        const result = await findCallers(findBySymbol, params.symbol, direction, {
          maxResults,
          sourceFile,
          resolver: resolver ? {
            resolve: (fp, sym) => resolver.resolve(fp, sym),
            getExports: (fp) => resolver.getExports(fp),
          } : undefined,
        })

        // Fallback: when sourceFile is provided but resolver is not available,
        // filter by chunk filePath as a simple path match
        if (sourceFile && !resolver && result.chunks) {
          result.chunks = result.chunks.filter(
            (c: any) => c.filePath === sourceFile || c.filePath.startsWith(sourceFile + '/')
          )
        }

        if (sourceFileWarning) {
          result.warning = sourceFileWarning
        }
        return result
      },
    }),
  )

  // ── trace_call_chain ────────────────────────────────────────────────

  ctx.tools.register(
    defineTool({
      name: 'trace_call_chain',
      description:
        '从入口符号出发，沿引用关系 BFS 追踪调用链。' +
        'direction=backward 做影响分析（找谁调用了入口），direction=forward 做依赖分析（入口调用了谁）。',

      parameters: {
        entry: {
          type: 'string',
          required: true,
          description: '入口符号名',
        },
        direction: {
          type: 'string',
          description: 'backward=影响分析（找调用者，默认）；forward=依赖分析（找被调用者）',
        },
        maxDepth: {
          type: 'number',
          description: '最大递归深度，默认 3',
        },
        maxResults: {
          type: 'number',
          description: '每层最大结果数，默认 10',
        },
        resolve: {
          type: 'boolean',
          description: '是否启用 import 解析（默认 true，设为 false 回退到 V1 名称匹配）',
        },
      },

      output: {
        schema: {
          type: 'object',
          properties: {
            chain: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  depth: { type: 'number' },
                  symbol: { type: 'string' },
                  filePath: { type: 'string' },
                  startLine: { type: 'number' },
                  endLine: { type: 'number' },
                  callers: {
                    type: 'array',
                    items: { type: 'string' },
                  },
                },
                additionalProperties: false,
              },
            },
          },
          additionalProperties: false,
        },
        render: (_args: any, value: any) => {
          const result = value as { chain: any[] }
          if (result.chain.length === 0) {
            return [{ type: 'text' as const, text: '未找到调用链。' }]
          }
          const lines = result.chain.map((n: any) => {
            const indent = '  '.repeat(n.depth)
            const callerList = n.callers.length > 0
              ? `\n${indent}  └─ 调用者: ${n.callers.join(', ')}`
              : ''
            return `${indent}${n.symbol} (${n.filePath}:${n.startLine}-${n.endLine})${callerList}`
          })
          return [{
            type: 'text' as const,
            text: `调用链 (${result.chain.length} 层):\n\n${lines.join('\n')}`,
          }]
        },
      },

      async execute(params: any, exec?: any) {
        await milvus.ensureCollection()
        const direction = params.direction === 'forward' ? 'forward' as const : 'backward' as const
        const maxDepth = params.maxDepth ?? 3
        const maxResults = params.maxResults ?? 10
        const resolve = params.resolve !== false

        const resolver = resolve && importResolver?.isLoaded() ? importResolver : undefined

        const findBySymbol: FindBySymbol = async (symbol, dir, limit) => {
          if (dir === 'backward') {
            const results = await milvus.queryByReference(symbol, limit)
            return results.map(r => ({
              filePath: r.filePath,
              content: r.content,
              startLine: r.startLine,
              endLine: r.endLine,
              chunkType: r.chunkType,
              name: r.name,
            }))
          } else {
            const results = await milvus.queryByName(symbol, limit)
            return results.map(r => ({
              filePath: r.filePath,
              content: r.content,
              startLine: r.startLine,
              endLine: r.endLine,
              chunkType: r.chunkType,
              name: r.name,
              references: (r as any).references ?? [],
            }))
          }
        }

        return traceChain(findBySymbol, params.entry, {
          direction, maxDepth, maxResults,
          resolver: resolver ? {
            resolve: (fp, sym) => resolver.resolve(fp, sym),
            getExports: (fp) => resolver.getExports(fp),
          } : undefined,
        })
      },
    }),
  )
}
