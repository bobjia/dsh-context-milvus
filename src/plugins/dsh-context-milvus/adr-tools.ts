/**
 * ADR tool definitions for dsh-context-milvus.
 *
 * Registers seven tools:
 * - search_adr: Semantic search within ADR decision records
 * - search_adr_by_file: Deterministic ADR lookup via code_anchors
 * - create_adr: Create a new ADR decision record
 * - update_adr: Update an existing ADR decision record
 * - list_adrs: List ADR decision records with optional filters
 * - load_constraints: Load active ADR constraints
 * - check_adr_consistency: Check ADR consistency against code
 */

import * as path from 'node:path'
import { access, readFile, writeFile, rename } from 'node:fs/promises'
import { dump as yamlDump, load as yamlLoad } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MilvusService } from './milvus-service.js'
import type { AdrService } from './adr-service.js'
import type { AdrAnchorIndex } from './adr-anchor-index.js'
import type { PluginConfig } from './config.js'
import type { HashTracker } from './merkle.js'
import { runAdrIndex } from './adr-indexer.js'

/** Format ADR search results for model consumption */
function formatAdrSearchResults(value: any[]): string {
  if (value.length === 0) return '未找到匹配的 ADR 决策记录。'
  return value.map((item: any, i: number) => {
    return [
      `[结果 ${i + 1}] ADR: ${item.adrId} (${item.status}), 章节: ${item.section}`,
      `文件: ${item.filePath}`,
      `相关度: ${item.score.toFixed(4)}`,
      `内容:`,
      item.content,
    ].join('\n')
  }).join('\n---\n')
}

export function registerAdrTools(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  milvus: MilvusService,
  adrService: AdrService,
  anchorIndex: AdrAnchorIndex,
  adrIndexer?: {  // NEW: for auto-indexing after create/update
    runAdrIndex: typeof runAdrIndex
    tracker: HashTracker
  },
): void {
  const config = resolveConfig()
  if (!config.adrEnabled) return

  // ── search_adr ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'search_adr',
    description: '在 ADR 决策记录中执行语义搜索。当需要了解某段代码的"为什么"时使用此工具。',
    parameters: {
      query: { type: 'string', required: true, description: '自然语言查询，如"为什么用了重试队列"' },
      path: { type: 'string', description: '限定 ADR 搜索路径范围（传递给 Milvus 的 pathPrefix 过滤）' },
      status: { type: 'string', description: '过滤状态: active | superseded | deprecated | all' },
      topK: { type: 'number', description: '返回结果数量，默认 5' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            adrId: { type: 'string' }, filePath: { type: 'string' },
            status: { type: 'string' }, section: { type: 'string' },
            content: { type: 'string' }, score: { type: 'number' },
            triggerType: { type: 'string' },
            codeAnchors: { type: 'array', items: { type: 'string' } },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => [{ type: 'text' as const, text: formatAdrSearchResults(value as any[]) }],
    },
    async execute(params: any) {
      await milvus.ensureAdrCollection()
      const filters: any = {}
      if (params.status && params.status !== 'all') filters.status = params.status
      if (params.path) filters.pathPrefix = params.path
      return milvus.searchAdr(params.query, params.topK ?? 5, Object.keys(filters).length > 0 ? filters : undefined)
    },
  }))

  // ── search_adr_by_file ──────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'search_adr_by_file',
    description: '通过代码文件路径查找相关的 ADR 决策记录。基于 code_anchors 确定性关联。',
    parameters: {
      file_path: { type: 'string', required: true, description: '代码文件路径' },
      status: { type: 'string', description: '过滤状态' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            adrId: { type: 'string' }, filePath: { type: 'string' },
            status: { type: 'string' }, summary: { type: 'string' },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => {
        if (value.length === 0) return [{ type: 'text' as const, text: '未找到关联的 ADR 决策记录。' }]
        const text = value.map((v: any) =>
          `- ${v.adrId} (${v.status}): ${v.summary?.slice(0, 100) || ''}`
        ).join('\n')
        return [{ type: 'text' as const, text: `关联的 ADR 决策记录:\n${text}` }]
      },
    },
    async execute(params: any) {
      const adrIds = anchorIndex.getAdrsForFile(params.file_path)
      if (adrIds.length === 0) return []
      const results = []
      for (const adrId of adrIds) {
        const doc = await adrService.loadAdr(adrId)
        if (doc && (!params.status || params.status === 'all' || doc.frontmatter.status === params.status)) {
          const firstSection = Object.values(doc.sections)[0] || ''
          results.push({
            adrId: doc.frontmatter.id,
            filePath: doc.filePath,
            status: doc.frontmatter.status,
            summary: firstSection.slice(0, 200),
          })
        }
      }
      return results
    },
  }))

  // ── create_adr ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'create_adr',
    description: '创建新的 ADR 决策记录。当做出新设计决策、引入新依赖或架构变更时使用。',
    parameters: {
      title: { type: 'string', required: true, description: 'kebab-case 简短描述，如 webhook-dead-letter-queue' },
      requirement: { type: 'string', description: '触发需求/变更描述' },
      change_type: { type: 'string', description: 'new_feature | refactor | bugfix | optimization | architecture' },
      supersedes: { type: 'string', description: '被替代的 ADR id' },
      content: { type: 'string', description: '自定义内容（留空则用模板自动生成）' },
    },
    output: {
      schema: {
        type: 'object', properties: {
          adrId: { type: 'string' }, filePath: { type: 'string' },
        }, additionalProperties: false,
      },
      render: (_args: any, value: any) => [
        { type: 'text' as const, text: `✅ ADR 已创建: ${value.adrId}\n路径: ${value.filePath}` },
      ],
    },
    async execute(params: any) {
      const result = await adrService.createAdr({
        title: params.title,
        requirement: params.requirement,
        changeType: params.change_type,
        supersedes: params.supersedes,
        content: params.content,
      })
      // Auto-index the newly created ADR
      if (adrIndexer) {
        const config = resolveConfig()
        const adrConfig = { ...config, adrRoot: path.resolve(config.indexRoot, config.adrRoot) }
        await adrIndexer.runAdrIndex(adrConfig, milvus, adrIndexer.tracker, anchorIndex, { mode: 'incremental' })
      }
      return { adrId: result.id, filePath: result.filePath }
    },
  }))

  // ── update_adr ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'update_adr',
    description: '更新已有 ADR 决策记录。修改约束、变更状态或补充内容时使用。',
    parameters: {
      adr_id: { type: 'string', required: true, description: 'ADR id，如 ADR-0001-test' },
      content: { type: 'string', description: '替换正文' },
      status: { type: 'string', description: '变更状态: active | superseded | deprecated' },
      superseded_by: { type: 'string', description: '标记被谁替代' },
      merge: { type: 'boolean', description: 'true 则合并内容（保留未传字段）' },
    },
    output: {
      schema: {
        type: 'object', properties: {
          adrId: { type: 'string' }, filePath: { type: 'string' },
        }, additionalProperties: false,
      },
      render: (_args: any, value: any) => [
        { type: 'text' as const, text: `✅ ADR 已更新: ${value.adrId}` },
      ],
    },
    async execute(params: any) {
      const result = await adrService.updateAdr(params.adr_id, {
        content: params.content,
        status: params.status,
        supersededBy: params.superseded_by,
        merge: params.merge,
      })
      // Re-index the updated ADR
      if (adrIndexer) {
        const config = resolveConfig()
        const adrConfig = { ...config, adrRoot: path.resolve(config.indexRoot, config.adrRoot) }
        await adrIndexer.runAdrIndex(adrConfig, milvus, adrIndexer.tracker, anchorIndex, { mode: 'incremental' })
      }
      return { adrId: result.id, filePath: result.filePath }
    },
  }))

  // ── list_adrs ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'list_adrs',
    description: '列出 ADR 决策记录目录。可按状态和变更类型过滤。',
    parameters: {
      status: { type: 'string', description: '过滤: active | superseded | deprecated | all (默认 active)' },
      change_type: { type: 'string', description: '过滤触发类型' },
      limit: { type: 'number', description: '结果数量限制，默认 100' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            id: { type: 'string' }, filePath: { type: 'string' },
            status: { type: 'string' }, created: { type: 'string' },
            anchorCount: { type: 'number' }, summary: { type: 'string' },
            changeType: { type: 'string' },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => {
        if (value.length === 0) return [{ type: 'text' as const, text: '没有找到匹配的 ADR。' }]
        const text = value.map((v: any) =>
          `${v.id} [${v.status}] ${v.changeType} — ${v.summary?.slice(0, 60) || ''}`
        ).join('\n')
        const counts = `共 ${value.length} 条 ADR 记录`
        return [{ type: 'text' as const, text: `${counts}\n${text}` }]
      },
    },
    async execute(params: any) {
      return adrService.listAdrs({
        status: params.status ?? 'active',
        changeType: params.change_type,
        limit: params.limit ?? 100,
      })
    },
  }))

  // ── load_constraints ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'load_constraints',
    description: '加载当前 active ADR 的约束条件，包括隐性约束和被否决的反模式。',
    parameters: {
      format: { type: 'string', description: 'summary | full（默认 summary）。full 模式包含隐性约束的完整详情' },
      adr_ids: { type: 'string', description: '指定 ADR id（逗号分隔），不传则加载所有 active' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            adrId: { type: 'string' }, adrTitle: { type: 'string' },
            constraints: { type: 'array', items: { type: 'string' } },
            hiddenConstraints: {
              type: 'array', items: {
                type: 'object', properties: {
                  name: { type: 'string' }, content: { type: 'string' }, consequence: { type: 'string' },
                }, additionalProperties: false,
              },
            },
            rejectedPatterns: { type: 'array', items: { type: 'string' } },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => {
        if (value.length === 0) return [{ type: 'text' as const, text: '没有 active 的约束。' }]
        const parts = value.map((v: any) => {
          const lines = [`## ${v.adrId}: ${v.adrTitle}`]
          if (v.constraints.length > 0) lines.push('约束:', ...v.constraints.map((c: string) => `  - ${c}`))
          if (v.hiddenConstraints?.length > 0) {
            lines.push('隐性约束:')
            v.hiddenConstraints.forEach((h: any) => {
              lines.push(`  - ${h.name}`)
              if (h.content) lines.push(`    内容: ${h.content}`)
              if (h.consequence) lines.push(`    后果: ${h.consequence}`)
            })
          }
          if (v.rejectedPatterns.length > 0) lines.push('被否决的反模式:', ...v.rejectedPatterns.map((p: string) => `  ❌ ${p}`))
          return lines.join('\n')
        })
        return [{ type: 'text' as const, text: parts.join('\n\n') }]
      },
    },
    async execute(params: any) {
      const all = await adrService.getActiveConstraints()
      let filtered = all
      if (params.adr_ids) {
        const ids = params.adr_ids.split(',').map((s: string) => s.trim())
        filtered = all.filter(c => ids.includes(c.adrId))
      }
      const format = params.format ?? 'summary'
      return filtered.map((c: any) => {
        const item: any = {
          adrId: c.adrId,
          adrTitle: c.adrTitle,
          constraints: c.constraints,
          rejectedPatterns: c.rejectedPatterns,
        }
        if (format === 'full') {
          item.hiddenConstraints = c.hiddenConstraints
        }
        return item
      })
    },
  }))

  // ── check_adr_consistency ───────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'check_adr_consistency',
    description: '检查 ADR 决策记录与代码的一致性。验证 code_anchors 是否仍然有效，检测未覆盖的变更。',
    parameters: {
      file_path: { type: 'string', description: '检查特定文件（不传则检查所有）' },
      fix: { type: 'boolean', description: '尝试自动修复失效锚点（从 ADR frontmatter 中移除已不存在的文件锚点）' },
    },
    output: {
      schema: {
        type: 'object', properties: {
          staleAnchors: { type: 'array', items: { type: 'object', properties: { adrId: { type: 'string' }, file: { type: 'string' }, issue: { type: 'string' } }, additionalProperties: false } },
          uncoveredChanges: { type: 'array', items: { type: 'object', properties: { adrId: { type: 'string' }, file: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false } },
          fixedAnchors: { type: 'array', items: { type: 'object', properties: { adrId: { type: 'string' }, file: { type: 'string' } }, additionalProperties: false } },
        }, additionalProperties: false,
      },
      render: (_args: any, value: any) => {
        const parts: string[] = ['## ADR 一致性检查结果']
        if (value.staleAnchors?.length > 0) {
          parts.push(`\n### 失效锚点 (${value.staleAnchors.length})`)
          value.staleAnchors.forEach((a: any) => parts.push(`  - ${a.adrId}: ${a.file} — ${a.issue}`))
        }
        if (value.fixedAnchors?.length > 0) {
          parts.push(`\n### 已修复锚点 (${value.fixedAnchors.length})`)
          value.fixedAnchors.forEach((a: any) => parts.push(`  - ${a.adrId}: ${a.file} — 已从 ADR frontmatter 中移除`))
        }
        if (value.uncoveredChanges?.length > 0) {
          parts.push(`\n### 未覆盖变更 (${value.uncoveredChanges.length})`)
          value.uncoveredChanges.forEach((a: any) => parts.push(`  - ${a.adrId}: ${a.file} — ${a.status}`))
        }
        if (!value.staleAnchors?.length && !value.uncoveredChanges?.length) {
          parts.push('\n✅ 未发现问题，所有 ADR 与代码一致。')
        }
        return [{ type: 'text' as const, text: parts.join('\n') }]
      },
    },
    async execute(params: any) {
      const staleAnchors: Array<{ adrId: string; file: string; issue: string }> = []
      const uncoveredChanges: Array<{ adrId: string; file: string; status: string }> = []
      const fixedAnchors: Array<{ adrId: string; file: string }> = []

      const allFiles = anchorIndex.getAll()
      const anchoredPaths = new Set(allFiles.keys())

      for (const [filePath, adrIds] of allFiles) {
        if (params.file_path && filePath !== params.file_path) continue
        try {
          await access(filePath)
        } catch {
          staleAnchors.push({ adrId: adrIds.join(', '), file: filePath, issue: '文件已不存在' })
        }
      }

      // If a specific file is requested but not tracked by any ADR, flag it as uncovered
      if (params.file_path && !anchoredPaths.has(params.file_path)) {
        uncoveredChanges.push({ adrId: 'N/A', file: params.file_path, status: 'uncovered' })
      }

      // Auto-fix: remove stale anchors from ADR frontmatter
      if (params.fix && staleAnchors.length > 0) {
        for (const anchor of staleAnchors) {
          const adrIdList = anchor.adrId.split(', ').filter(Boolean)
          for (const adrId of adrIdList) {
            try {
              // Load the ADR document to get the file path
              const doc = await adrService.loadAdr(adrId)
              if (!doc) continue

              // Read the raw file content
              let content = await readFile(doc.filePath, 'utf-8')

              // Parse the frontmatter YAML
              const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/)
              if (!fmMatch) continue

              const rawFm = fmMatch[1]
              const parsedFm = yamlLoad(rawFm) as Record<string, any>
              if (!Array.isArray(parsedFm.code_anchors)) continue

              // Filter out the stale anchor (match by file path)
              const before = parsedFm.code_anchors.length
              parsedFm.code_anchors = parsedFm.code_anchors.filter(
                (a: any) => a?.file !== anchor.file,
              )
              if (parsedFm.code_anchors.length === before) continue

              // Re-serialize the frontmatter
              const newFm = yamlDump(parsedFm, { lineWidth: 120, noRefs: true, sortKeys: false })
              const newContent = content.replace(fmMatch[0], `---\n${newFm}---\n`)

              // Atomic write
              const tmpPath = `${doc.filePath}.tmp`
              await writeFile(tmpPath, newContent, 'utf-8')
              await rename(tmpPath, doc.filePath)

              fixedAnchors.push({ adrId, file: anchor.file })
            } catch {
              // Silently skip errors during fix
            }
          }
        }
      }

      return { staleAnchors, uncoveredChanges, fixedAnchors }
    },
  }))
}