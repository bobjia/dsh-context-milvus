import type {
  SearchResult, IndexResult, IndexStatus, CallersResult, TraceResult,
  AdrSearchResult, AdrListItem,
} from 'dsh-context-milvus-core'

export type ErrorCode =
  | 'E_WORKSPACE_NOT_FOUND' | 'E_MILVUS_UNREACHABLE' | 'E_COLLECTION_INIT'
  | 'E_EMBEDDING_FAILED' | 'E_EMBEDDING_DIM_MISMATCH' | 'E_INDEX_ROOT_UNREADABLE'
  | 'E_IMPORT_MAP_MISSING'
  | 'E_ADR_WRITE_DISABLED' | 'E_ADR_NOT_INITIALIZED' | 'E_INTERNAL'

// These are type aliases rather than interfaces on purpose: the MCP SDK's
// CallToolResult carries a string index signature, and TypeScript only gives
// implicit index signatures to object type literals, not to interfaces.
export type TextContent = { type: 'text'; text: string }

export type ToolStructuredResult<T> = {
  content: TextContent[]
  structuredContent: T
  isError: false
}

export type ToolErrorResult = {
  content: TextContent[]
  isError: true
}

export type ToolResult<T> = ToolStructuredResult<T> | ToolErrorResult

export function okResult<T>(data: T, text: string): ToolResult<T> {
  return { content: [{ type: 'text', text }], structuredContent: data, isError: false }
}

export function errorResult(code: ErrorCode, message: string, hint: string): ToolErrorResult {
  return {
    content: [{ type: 'text', text: `错误 [${code}]: ${message}\n建议：${hint}` }],
    isError: true,
  }
}

/** 混合检索说明行：每个输出只出现一次，位于第一条结果之前。 */
const RRF_NOTE = '（混合检索：结果按 RRF 融合排序，仅提供名次，不提供绝对相似度分值。）'

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return '未找到匹配的代码片段。'
  const body = results.map((item, i) => {
    const lang = item.language ? ` (${item.language})` : ''
    const name = item.name ? `「${item.name}」` : ''
    // 缺失或未知的 scoreKind 一律按 similarity 处理（向后兼容，绝不抛错）。
    const kind = item.scoreKind ?? 'similarity'
    return [
      `[结果 ${i + 1}] 文件: ${item.filePath}${lang}, 第 ${item.startLine}-${item.endLine} 行 ${name}`,
      // RRF 分是 1/(k+名次) 的名次编码，不是相似度：只报名次。
      kind === 'rrf' ? `排序: ${i + 1}/${results.length}` : `相关度: ${item.score.toFixed(4)}`,
      `类型: ${item.chunkType || '未知'}`,
      '内容:',
      '```' + (item.language || ''),
      item.content,
      '```',
    ].join('\n')
  }).join('\n---\n')

  return results.some((item) => (item.scoreKind ?? 'similarity') === 'rrf')
    ? `${RRF_NOTE}\n${body}`
    : body
}

export function formatIndexResult(result: IndexResult): string {
  return [
    `索引完成 (${(result.durationMs / 1000).toFixed(1)}s)`,
    `  - 新增/修改: ${result.filesIndexed} 个文件, ${result.chunksIndexed} 个代码块`,
    `  - 已删除: ${result.filesRemoved} 个文件, ${result.chunksRemoved} 个代码块`,
    `  - 未变更跳过: ${result.filesSkipped} 个文件`,
  ].join('\n')
}

export function formatStatus(status: IndexStatus): string {
  return [
    '📊 索引状态',
    `  已索引文件: ${status.totalFiles}`,
    `  代码块总数: ${status.totalChunks}`,
    `  最后索引: ${status.lastIndexed || '从未索引'}`,
    `  支持的文件类型: ${status.indexedExtensions.join(', ')}`,
  ].join('\n')
}

export function formatCallers(result: CallersResult): string {
  if (result.chunks.length === 0) {
    return result.warning ? `未找到引用该符号的代码。${result.warning}` : '未找到引用该符号的代码。'
  }
  const header = result.warning
    ? `找到 ${result.chunks.length} 个引用位置：${result.warning}\n\n`
    : `找到 ${result.chunks.length} 个引用位置：\n\n`
  return header + result.chunks.map((c, i) => {
    const res = c.resolution?.status ? ` (${c.resolution.status})` : ''
    const body = c.content.length > 200 ? c.content.slice(0, 200) + '...' : c.content
    return [`[${i + 1}] ${c.filePath}:${c.startLine}-${c.endLine}${res}`,
            `    ${c.chunkType}「${c.name}」`, body].join('\n')
  }).join('\n---\n')
}

export function formatChain(result: TraceResult): string {
  if (result.chain.length === 0) return '未找到调用链。'
  const lines = result.chain.map((n) => {
    const indent = '  '.repeat(n.depth)
    const callers = n.callers.length > 0 ? `\n${indent}  └─ 调用者: ${n.callers.join(', ')}` : ''
    return `${indent}${n.symbol} (${n.filePath}:${n.startLine}-${n.endLine})${callers}`
  })
  return `调用链 (${result.chain.length} 层):\n\n${lines.join('\n')}`
}

export function formatAdrSearch(results: AdrSearchResult[]): string {
  if (results.length === 0) return '未找到匹配的 ADR 决策记录。'
  const body = results.map((item, i) => {
    const typeLabel = item.docType === 'spec' ? ', spec' : item.docType === 'plan' ? ', plan' : ''
    // 缺失或未知的 scoreKind 一律按 similarity 处理（向后兼容，绝不抛错）。
    const kind = item.scoreKind ?? 'similarity'
    return [
      `[结果 ${i + 1}] ADR: ${item.adrId} (${item.status}${typeLabel}), 章节: ${item.section}`,
      `文件: ${item.filePath}`,
      // RRF 分是 1/(k+名次) 的名次编码，不是相似度：只报名次。
      kind === 'rrf' ? `排序: ${i + 1}/${results.length}` : `相关度: ${item.score.toFixed(4)}`,
      '内容:',
      item.content,
    ].join('\n')
  }).join('\n---\n')

  return results.some((item) => (item.scoreKind ?? 'similarity') === 'rrf')
    ? `${RRF_NOTE}\n${body}`
    : body
}

export function formatAdrByFile(adrs: Array<{ adrId: string; status: string; summary: string }>): string {
  if (adrs.length === 0) return '未找到关联的 ADR 决策记录。'
  const body = adrs.map((v) => `- ${v.adrId} (${v.status}): ${v.summary.slice(0, 100)}`).join('\n')
  return `关联的 ADR 决策记录:\n${body}`
}

export function formatAdrList(adrs: AdrListItem[]): string {
  if (adrs.length === 0) return '没有找到匹配的 ADR。'
  const body = adrs.map((v) => `${v.id} [${v.status}] ${v.changeType} — ${v.summary.slice(0, 60)}`).join('\n')
  return `共 ${adrs.length} 条 ADR 记录\n${body}`
}

export function formatConstraints(items: Array<{
  adrId: string; adrTitle: string; constraints: string[]
  rejectedPatterns: string[]; hiddenConstraints?: Array<{ name: string; content: string; consequence: string }>
}>): string {
  if (items.length === 0) return '没有 active 的约束。'
  return items.map((v) => {
    const lines = [`## ${v.adrId}: ${v.adrTitle}`]
    if (v.constraints.length) lines.push('约束:', ...v.constraints.map((c) => `  - ${c}`))
    if (v.hiddenConstraints?.length) {
      lines.push('隐性约束:')
      for (const h of v.hiddenConstraints) {
        lines.push(`  - ${h.name}`)
        if (h.content) lines.push(`    内容: ${h.content}`)
        if (h.consequence) lines.push(`    后果: ${h.consequence}`)
      }
    }
    if (v.rejectedPatterns.length) {
      lines.push('被否决的反模式:', ...v.rejectedPatterns.map((p) => `  ❌ ${p}`))
    }
    return lines.join('\n')
  }).join('\n\n')
}

export function formatAdrConsistency(r: {
  staleAnchors: Array<{ adrId: string; file: string; issue: string }>
  uncoveredChanges: Array<{ adrId: string; file: string; status: string }>
  fixedAnchors: Array<{ adrId: string; file: string }>
}): string {
  const parts: string[] = ['## ADR 一致性检查结果']
  if (r.staleAnchors.length) {
    parts.push(`\n### 失效锚点 (${r.staleAnchors.length})`,
      ...r.staleAnchors.map((a) => `  - ${a.adrId}: ${a.file} — ${a.issue}`))
  }
  if (r.fixedAnchors.length) {
    parts.push(`\n### 已修复锚点 (${r.fixedAnchors.length})`,
      ...r.fixedAnchors.map((a) => `  - ${a.adrId}: ${a.file} — 已从 ADR frontmatter 中移除`))
  }
  if (r.uncoveredChanges.length) {
    parts.push(`\n### 未覆盖变更 (${r.uncoveredChanges.length})`,
      ...r.uncoveredChanges.map((a) => `  - ${a.adrId}: ${a.file} — ${a.status}`))
  }
  if (!r.staleAnchors.length && !r.uncoveredChanges.length) {
    parts.push('\n✅ 未发现问题，所有 ADR 与代码一致。')
  }
  return parts.join('\n')
}

/**
 * Append the ADR reminder. Returns the input untouched when no hit is covered,
 * which is what keeps the default search output stable.
 */
export function appendAdrHints(
  text: string,
  related: Array<{ adrId: string; title: string; status: string }>,
): string {
  if (related.length === 0) return text
  const body = related.map((a) => {
    const title = a.title.length > 60 ? `${a.title.slice(0, 60)}…` : a.title
    return [a.adrId, title, `(${a.status})`].filter(Boolean).join(' ')
  })
  return `${text}\n相关决策: ${body.join(' · ')}`
}
