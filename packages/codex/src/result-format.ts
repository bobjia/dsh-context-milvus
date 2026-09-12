import type {
  SearchResult, IndexResult, IndexStatus, CallersResult, TraceResult,
} from 'dsh-context-milvus-core'

export type ErrorCode =
  | 'E_WORKSPACE_NOT_FOUND' | 'E_MILVUS_UNREACHABLE' | 'E_COLLECTION_INIT'
  | 'E_EMBEDDING_FAILED' | 'E_EMBEDDING_DIM_MISMATCH' | 'E_INDEX_ROOT_UNREADABLE'
  | 'E_IMPORT_MAP_MISSING' | 'E_INTERNAL'

export interface TextContent { type: 'text'; text: string }

export interface ToolStructuredResult<T> {
  content: TextContent[]
  structuredContent: T
  isError: false
}

export interface ToolErrorResult {
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

export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return '未找到匹配的代码片段。'
  return results.map((item, i) => {
    const lang = item.language ? ` (${item.language})` : ''
    const name = item.name ? `「${item.name}」` : ''
    return [
      `[结果 ${i + 1}] 文件: ${item.filePath}${lang}, 第 ${item.startLine}-${item.endLine} 行 ${name}`,
      `相关度: ${item.score.toFixed(4)}`,
      `类型: ${item.chunkType || '未知'}`,
      '内容:',
      '```' + (item.language || ''),
      item.content,
      '```',
    ].join('\n')
  }).join('\n---\n')
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
