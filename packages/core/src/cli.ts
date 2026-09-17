/**
 * Standalone indexing CLI, shared by any adapter that wants to expose it.
 *
 * The DSH plugin ships this as the `dsh-context-milvus-index` bin: index_code
 * and index_specs refuse to do heavy work inline on a large corpus and instead
 * tell the user to run this in a terminal, where no session timeout applies.
 *
 * All output goes through an injected CliIo: core must not call console.*
 * directly (see core-boundary.spec.ts).
 */
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { findCandidateFiles, generateSpecFrontmatter } from './adr-anchor-generator.js'
import { createAdrBundle } from './adr-bundle.js'
import { runAdrIndex, PLAN_FILE_RE, SPEC_FILE_RE } from './adr-indexer.js'
import { chunkCode } from './chunker.js'
import { deriveImportMapFilePath, deriveMerkleFilePath, deriveRunConfigPath, getConfig, type PluginConfig } from './config.js'
import { EmbeddingClient } from './embedding.js'
import { ImportResolver } from './import-resolver.js'
import { probeWorkspace, runIndex } from './indexer.js'
import { HashTracker } from './merkle.js'
import { MilvusService } from './milvus-service.js'
import { readRunConfig } from './run-config.js'

export interface CliIo {
  out: (line: string) => void
  err: (line: string) => void
}

interface CliArgs {
  root: string
  mode: 'full' | 'incremental'
  configPath?: string
  dryRun: boolean
  specsOnly: boolean
  noAdr: boolean
  verbose: boolean
  help: boolean
}

export const CLI_USAGE = `用法: dsh-context-milvus-index [选项]

在终端独立完成代码库与规格文档的索引（Embedding + Milvus 上传）。
大工作区下 DSH 的 index_code / index_specs 会提示你运行本命令。

选项:
  --root <path>    工作区根目录（默认: 当前目录）
  --mode <mode>    full | incremental（默认: incremental）
  --config <path>  指定 run-config.json（默认按 --root 派生）
  --specs-only     只处理 spec/plan 文档（frontmatter 生成 + 索引）
  --no-adr         跳过 ADR 与规格索引
  --dry-run        只扫描统计，不连接 Milvus、不写入
  --verbose        打印逐文件进度
  -h, --help       显示本帮助`

export function parseCliArgs(argv: string[]): { args: CliArgs } | { error: string } {
  const args: CliArgs = {
    root: process.cwd(), mode: 'incremental', dryRun: false,
    specsOnly: false, noAdr: false, verbose: false, help: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '-h' || arg === '--help') args.help = true
    else if (arg === '--dry-run') args.dryRun = true
    else if (arg === '--specs-only') args.specsOnly = true
    else if (arg === '--no-adr') args.noAdr = true
    else if (arg === '--verbose') args.verbose = true
    else if (arg === '--root') {
      const value = argv[++i]
      if (!value) return { error: '--root 需要一个路径参数' }
      args.root = value
    } else if (arg === '--config') {
      const value = argv[++i]
      if (!value) return { error: '--config 需要一个路径参数' }
      args.configPath = value
    } else if (arg === '--mode') {
      const value = argv[++i]
      if (value !== 'full' && value !== 'incremental') {
        return { error: `--mode 只接受 full 或 incremental（收到 ${value ?? '(空)'}）` }
      }
      args.mode = value
    } else {
      return { error: `未知参数: ${arg}` }
    }
  }

  return { args }
}

/** Resolve the effective config: --config > per-workspace run-config > env + defaults. */
async function resolveConfig(root: string, args: CliArgs, io: CliIo): Promise<PluginConfig> {
  const configPath = args.configPath ? path.resolve(args.configPath) : deriveRunConfigPath(root)
  const file = await readRunConfig(configPath)

  if (file) {
    if (path.resolve(file.config.indexRoot) !== root) {
      io.err(`[index] 注意: run-config 的 indexRoot 是 ${file.config.indexRoot}，与 --root ${root} 不同；以 run-config 为准。`)
    }
    return file.config
  }

  io.err(`[index] 未找到可用的 run-config: ${configPath}`)
  io.err('[index] 回退到环境变量与默认值；先在 DSH 中运行一次 index_code 可生成与插件一致的配置。')
  return { ...getConfig({}), indexRoot: root, merkleFilePath: deriveMerkleFilePath(root) }
}

/** Scan-only mode: report scale without touching Milvus or writing anything. */
async function runDryRun(config: PluginConfig, args: CliArgs, io: CliIo): Promise<number> {
  const probe = await probeWorkspace(config, {
    onFileProgress: args.verbose ? (p) => io.out(`  ${p}`) : undefined,
  })

  let chunks = 0
  for (const filePath of probe.files.keys()) {
    try {
      const content = await readFile(filePath, 'utf-8')
      const parsed = await chunkCode(filePath, content, path.extname(filePath).toLowerCase(), {
        contextLines: config.chunkContextLines,
      })
      chunks += parsed.length
    } catch {
      // Unreadable file — it would be skipped by a real run too
    }
  }

  io.out(`[dry-run] 工作区: ${config.indexRoot}`)
  io.out(`[dry-run] 可索引文件: ${probe.fileCount}`)
  io.out(`[dry-run] 源码字节: ${probe.totalBytes}`)
  io.out(`[dry-run] 预估代码块: ${chunks}`)
  io.out(`[dry-run] 超过大工作区阈值: ${probe.exceedsLargeWorkspace ? '是' : '否'}`)
  return 0
}

/** Generate frontmatter for spec/plan candidates, then index the ADR/spec corpus. */
async function runSpecsAndAdr(
  config: PluginConfig,
  milvus: MilvusService,
  args: CliArgs,
  io: CliIo,
): Promise<void> {
  const adrConfig: PluginConfig = {
    ...config,
    adrRoot: path.resolve(config.indexRoot, config.adrRoot || 'docs/decisions'),
    specRoot: path.resolve(config.indexRoot, config.specRoot || 'docs/superpowers/specs'),
    planRoot: path.resolve(config.indexRoot, config.planRoot || 'docs/superpowers/plans'),
  }

  const candidates = [
    ...await findCandidateFiles(adrConfig.specRoot, SPEC_FILE_RE),
    ...await findCandidateFiles(adrConfig.planRoot, PLAN_FILE_RE),
  ]

  let generated = 0
  for (const filePath of candidates) {
    try {
      if (await generateSpecFrontmatter(filePath, adrConfig.indexRoot)) generated++
    } catch (err) {
      io.err(`[specs] 生成 frontmatter 失败 ${filePath}: ${(err as Error).message}`)
    }
  }
  io.out(`[specs] frontmatter 生成: ${generated} / 候选 ${candidates.length}`)

  const bundle = await createAdrBundle(adrConfig, { createWhenMissing: true })
  const result = await runAdrIndex(adrConfig, milvus, bundle.tracker, bundle.anchorIndex, {
    mode: args.mode,
    progress: (msg) => io.out(`[adr] ${msg}`),
  })
  io.out(`[adr] 完成: ${result.filesIndexed} 个文件 / ${result.chunksIndexed} 个代码块`)
}

export async function runIndexCli(argv: string[], io: CliIo): Promise<number> {
  const parsed = parseCliArgs(argv)
  if ('error' in parsed) {
    io.err(parsed.error)
    io.err(CLI_USAGE)
    return 2
  }

  const args = parsed.args
  if (args.help) {
    io.out(CLI_USAGE)
    return 0
  }

  const root = path.resolve(args.root)
  const config = await resolveConfig(root, args, io)

  if (args.dryRun) return runDryRun(config, args, io)

  const embeddingClient = new EmbeddingClient(config.embedding)
  const milvus = new MilvusService({
    address: config.milvusAddress,
    token: config.milvusToken,
    collection: config.milvusCollection,
    dim: config.milvusDim,
    embeddingClient,
    hybridMode: config.hybridMode,
    bm25RrfK: config.bm25RrfK,
    queryExpansion: config.queryExpansion,
    rerankConfig: { enabled: config.rerankEnabled, multiplier: config.rerankMultiplier },
  })

  const tracker = new HashTracker(config.merkleFilePath)
  await tracker.load().catch(() => {})
  const importResolver = new ImportResolver(deriveImportMapFilePath(config.indexRoot))
  await importResolver.load().catch(() => {})

  // Ctrl-C must not throw away the work already embedded.
  const onSigint = () => {
    void tracker.save().finally(() => process.exit(130))
  }
  process.on('SIGINT', onSigint)

  try {
    if (!args.specsOnly) {
      const result = await runIndex(config, milvus, tracker, {
        mode: args.mode,
        progress: (msg) => io.out(`[index] ${msg}`),
        onFileProgress: args.verbose ? (p) => io.out(`  ${p}`) : undefined,
        importResolver,
      })
      io.out(
        `[index] 完成: ${result.filesIndexed} 个文件 / ${result.chunksIndexed} 个代码块 ` +
        `(${(result.durationMs / 1000).toFixed(1)}s)`,
      )
      if (result.filesRemoved || result.chunksRemoved) {
        io.out(`[index] 清理: ${result.filesRemoved} 个文件 / ${result.chunksRemoved} 个代码块`)
      }
    }

    if (args.noAdr) {
      io.out('[adr] 已按 --no-adr 跳过 ADR 与规格索引')
      return 0
    }

    if (!config.adrEnabled) {
      if (args.specsOnly) {
        io.err('[specs] 规格索引属于 ADR 功能：请在 DSH 设置面板启用 adrEnabled 后重试')
        return 1
      }
      io.out('[adr] adrEnabled=false，跳过 ADR 与规格索引')
      return 0
    }

    await runSpecsAndAdr(config, milvus, args, io)
    return 0
  } catch (err) {
    io.err(`[index] 失败: ${(err as Error).message}`)
    return 1
  } finally {
    process.off('SIGINT', onSigint)
    await tracker.save().catch(() => {})
  }
}
