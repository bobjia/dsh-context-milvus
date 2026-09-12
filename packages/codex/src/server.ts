import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WorkspaceServiceCache } from './workspace-services.js'
import { createStderrLogger } from './context.js'
import {
  handleSearchCode, handleIndexCode, handleIndexStatus,
  handleFindCallers, handleTraceCallChain, type ServiceProvider,
} from './handlers.js'
import {
  okResult, errorResult, formatSearchResults, formatIndexResult, formatStatus,
  formatCallers, formatChain,
} from './result-format.js'
import {
  searchCodeSchema, indexCodeSchema, indexStatusSchema,
  findCallersSchema, traceCallChainSchema,
} from './schemas.js'

export const VERSION = '0.1.0'

function classify(err: unknown): ReturnType<typeof errorResult> {
  const message = err instanceof Error ? err.message : String(err)
  if (err && typeof err === 'object' && (err as any).code === 'E_WORKSPACE_NOT_FOUND') {
    return errorResult('E_WORKSPACE_NOT_FOUND', message, '检查 path 参数，或省略它让工具自动发现工作区')
  }
  if (/ECONNREFUSED|UNAVAILABLE|connect/i.test(message)) {
    return errorResult('E_MILVUS_UNREACHABLE', message, '确认 Milvus 已启动，并检查 MILVUS_ADDRESS')
  }
  if (/embedding/i.test(message)) {
    return errorResult('E_EMBEDDING_FAILED', message, '检查 EMBEDDING_ENDPOINT 与 EMBEDDING_MODEL')
  }
  return errorResult('E_INTERNAL', message, '查看 Codex MCP server 的 stderr 日志')
}

export function createServer(provider?: ServiceProvider): McpServer {
  const logger = createStderrLogger()
  const cache = new WorkspaceServiceCache(logger)
  const resolveServices: ServiceProvider = provider ?? ((root) => cache.get(root))
  const server = new McpServer({ name: 'codex-context-milvus', version: VERSION })

  const wrap = <T>(run: () => Promise<{ payload: T; text: string }>) =>
    run().then(r => okResult(r.payload, r.text)).catch(classify)

  server.registerTool('search_code', {
    description: '在代码库中执行语义搜索。定位功能实现、理解代码逻辑时优先使用。',
    inputSchema: searchCodeSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleSearchCode(resolveServices, logger, args)
    return { payload: { root: out.root, source: out.source, results: out.results },
             text: formatSearchResults(out.results) }
  }))

  server.registerTool('index_code', {
    description: '索引代码仓库到向量数据库。首次搜索前必须先执行一次。',
    inputSchema: indexCodeSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleIndexCode(resolveServices, logger, args)
    return { payload: { root: out.root, source: out.source, ...out.result },
             text: formatIndexResult(out.result) }
  }))

  server.registerTool('index_status', {
    description: '查看索引状态：已索引文件数、代码块数、最后索引时间。',
    inputSchema: indexStatusSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleIndexStatus(resolveServices, logger, args)
    return { payload: { root: out.root, source: out.source, ...out.status },
             text: formatStatus(out.status) }
  }))

  server.registerTool('find_callers', {
    description: '查找引用某符号的所有位置，用于修改前的影响分析。',
    inputSchema: findCallersSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleFindCallers(resolveServices, logger, args)
    return { payload: { root: out.root, ...out.result }, text: formatCallers(out.result) }
  }))

  server.registerTool('trace_call_chain', {
    description: '从入口符号出发 BFS 追踪调用链（影响/依赖分析）。',
    inputSchema: traceCallChainSchema,
  }, async (args: any) => wrap(async () => {
    const out = await handleTraceCallChain(resolveServices, logger, args)
    return { payload: { root: out.root, ...out.result }, text: formatChain(out.result) }
  }))

  return server
}

export async function main(): Promise<void> {
  const server = createServer()
  await server.connect(new StdioServerTransport())
}

process.on('uncaughtException', (err) => {
  console.error('[codex-context-milvus] uncaughtException:', err)
})
process.on('unhandledRejection', (err) => {
  console.error('[codex-context-milvus] unhandledRejection:', err)
})
