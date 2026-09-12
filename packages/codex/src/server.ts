import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { WorkspaceServiceCache } from './workspace-services.js'
import { createStderrLogger } from './context.js'
import {
  handleSearchCode, handleIndexCode, handleIndexStatus,
  handleFindCallers, handleTraceCallChain, type ServiceProvider,
} from './handlers.js'
import {
  handleSearchAdr, handleSearchAdrByFile, handleListAdrs, handleLoadConstraints,
  handleCreateAdr, handleUpdateAdr, handleCheckAdrConsistency, handleIndexSpecs,
} from './adr-handlers.js'
import {
  okResult, errorResult, formatSearchResults, formatIndexResult, formatStatus,
  formatCallers, formatChain,
  formatAdrSearch, formatAdrByFile, formatAdrList, formatConstraints,
  formatAdrConsistency, appendAdrHints,
} from './result-format.js'
import {
  searchCodeSchema, indexCodeSchema, indexStatusSchema,
  findCallersSchema, traceCallChainSchema,
  searchAdrSchema, searchAdrByFileSchema, listAdrsSchema, loadConstraintsSchema,
  createAdrSchema, updateAdrSchema, checkAdrConsistencySchema, indexSpecsSchema,
} from './schemas.js'
import { getConfig } from 'dsh-context-milvus-core'
import { ADR_WRITE_ENV } from './adr-gate.js'

export const VERSION = '0.1.0'

function classify(err: unknown): ReturnType<typeof errorResult> {
  const message = err instanceof Error ? err.message : String(err)
  if (err && typeof err === 'object' && (err as any).code === 'E_WORKSPACE_NOT_FOUND') {
    return errorResult('E_WORKSPACE_NOT_FOUND', message, '检查 path 参数，或省略它让工具自动发现工作区')
  }
  // ADR 的两个错误靠 AdrError.code 判定：必须在下面的正则兜底之前，
  // 否则 "ADR ... 写盘" 这类消息会被 E_INTERNAL 吞掉，agent 拿不到开关名。
  if (err && typeof err === 'object' && (err as any).code === 'E_ADR_WRITE_DISABLED') {
    return errorResult('E_ADR_WRITE_DISABLED', message, `设 ${ADR_WRITE_ENV}=true 后重启 Codex`)
  }
  if (err && typeof err === 'object' && (err as any).code === 'E_ADR_NOT_INITIALIZED') {
    return errorResult('E_ADR_NOT_INITIALIZED', message, '检查 ADR_ROOT 指向的目录是否存在')
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
    return { payload: { root: out.root, source: out.source, results: out.results, relatedAdrs: out.relatedAdrs },
             text: appendAdrHints(formatSearchResults(out.results), out.relatedAdrs) }
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

  // ADR tools only appear when the server is started with ADR_ENABLED. MCP has
  // no way to grow its tool list mid-session, so this is decided once at boot.
  const adrEnabled = getConfig().adrEnabled
  logger.debug('ADR tools', { enabled: adrEnabled })

  if (adrEnabled) {
    server.registerTool('search_adr', {
      description: '在 ADR 决策记录中做语义搜索。需要知道一段代码"为什么这样写"时使用。',
      inputSchema: searchAdrSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleSearchAdr(resolveServices, logger, args)
      return { payload: { root: out.root, results: out.results }, text: formatAdrSearch(out.results) }
    }))

    server.registerTool('search_adr_by_file', {
      description: '按代码文件路径查关联的 ADR 决策记录（基于 code_anchors 的确定性关联）。',
      inputSchema: searchAdrByFileSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleSearchAdrByFile(resolveServices, logger, args)
      return { payload: { root: out.root, adrs: out.adrs }, text: formatAdrByFile(out.adrs) }
    }))

    server.registerTool('list_adrs', {
      description: '列出 ADR 决策记录，可按状态与变更类型过滤。',
      inputSchema: listAdrsSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleListAdrs(resolveServices, logger, args)
      return { payload: { root: out.root, adrs: out.adrs }, text: formatAdrList(out.adrs) }
    }))

    server.registerTool('load_constraints', {
      description: '加载 active ADR 的约束、隐性约束与被否决的反模式。',
      inputSchema: loadConstraintsSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleLoadConstraints(resolveServices, logger, args)
      return { payload: { root: out.root, constraints: out.constraints }, text: formatConstraints(out.constraints) }
    }))

    // 以下四个会写盘（index_specs/check_adr_consistency 仅在显式要求时），
    // 因此另外受 CONTEXT_MILVUS_ADR_WRITE 保护。
    server.registerTool('create_adr', {
      description: '创建 ADR 决策记录。做出新设计决策、引入新依赖或架构变更时使用。写盘操作，需 CONTEXT_MILVUS_ADR_WRITE=true。',
      inputSchema: createAdrSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleCreateAdr(resolveServices, logger, args)
      return { payload: { root: out.root, ...out.adr },
               text: `✅ ADR 已创建: ${out.adr.adrId}\n路径: ${out.adr.filePath}` }
    }))

    server.registerTool('update_adr', {
      description: '更新已有 ADR：改约束、换状态、补内容。写盘操作，需 CONTEXT_MILVUS_ADR_WRITE=true。',
      inputSchema: updateAdrSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleUpdateAdr(resolveServices, logger, args)
      return { payload: { root: out.root, ...out.adr }, text: `✅ ADR 已更新: ${out.adr.adrId}` }
    }))

    server.registerTool('check_adr_consistency', {
      description: '检查 ADR 的 code_anchors 是否仍有效、变更是否未被覆盖。默认只报告，fix 才写盘。',
      inputSchema: checkAdrConsistencySchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleCheckAdrConsistency(resolveServices, logger, args)
      return { payload: { root: out.root, ...out.report }, text: formatAdrConsistency(out.report) }
    }))

    server.registerTool('index_specs', {
      description: '扫描规格文档、生成 code_anchors 并索引。默认 dryRun 只预览；真正落盘需 CONTEXT_MILVUS_ADR_WRITE=true。',
      inputSchema: indexSpecsSchema,
    }, async (args: any) => wrap(async () => {
      const out = await handleIndexSpecs(resolveServices, logger, args)
      const r = out.result
      const lines = [
        `文件处理: ${r.filesProcessed}`,
        `锚点生成: ${r.anchorsGenerated}`,
        r.dryRun ? '模式: 预览（未写入文件）'
                 : `文件索引: ${r.filesIndexed}\n分块索引: ${r.chunksIndexed}`,
      ]
      if (r.preview.length) {
        lines.push('')
        for (const p of r.preview) {
          lines.push(`  ${p.adrId}: ${p.filePath}`)
          for (const ref of p.detectedRefs) {
            lines.push(`    引用: ${ref.file}${ref.symbols.length ? ` (${ref.symbols.join(', ')})` : ''}`)
          }
        }
      }
      return { payload: { root: out.root, ...r }, text: lines.join('\n') }
    }))
  }

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
