import { createInterface } from 'node:readline/promises'
import { resolveWorkspaceRoot } from './workspace-resolver.js'
import { writeProjectConfig, type InitOptions } from './init-wizard.js'

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}

export async function runInitCli(args: string[]): Promise<void> {
  const root = resolveWorkspaceRoot(flag(args, 'workspace')).root
  const nonInteractive = args.includes('--non-interactive') || args.includes('--yes')

  const options: InitOptions = {
    milvusAddress: flag(args, 'milvus-address') ?? 'localhost:19530',
    embeddingEndpoint: flag(args, 'embedding-endpoint') ?? 'http://localhost:11434/api/embed',
    embeddingModel: flag(args, 'embedding-model') ?? 'nomic-embed-text',
    workspaceRoot: root,
    localMcpPath: flag(args, 'local-mcp-path'),
  }

  if (!nonInteractive) {
    const rl = createInterface({ input: process.stdin, output: process.stderr })
    options.milvusAddress = (await rl.question(`Milvus 地址 [${options.milvusAddress}]: `)) || options.milvusAddress
    options.embeddingEndpoint = (await rl.question(`Embedding endpoint [${options.embeddingEndpoint}]: `)) || options.embeddingEndpoint
    options.embeddingModel = (await rl.question(`Embedding model [${options.embeddingModel}]: `)) || options.embeddingModel
    const writeSecrets = await rl.question('是否写入 MILVUS_TOKEN / EMBEDDING_API_KEY？（y/N）: ')
    if (writeSecrets.trim().toLowerCase() === 'y') {
      const token = await rl.question('MILVUS_TOKEN（留空跳过）: ')
      if (token) options.milvusToken = token
      const key = await rl.question('EMBEDDING_API_KEY（留空跳过）: ')
      if (key) options.embeddingApiKey = key
    }
    rl.close()
  }

  const result = await writeProjectConfig(root, options)
  console.error(result.changed
    ? `已写入 ${result.path}${result.backup ? `（备份: ${result.backup}）` : ''}`
    : `配置未变化: ${result.path}`)
}
