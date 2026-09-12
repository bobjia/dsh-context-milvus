import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { getConfig, MilvusService, EmbeddingClient } from 'dsh-context-milvus-core'
import { createStderrLogger } from './context.js'
import { resolveWorkspaceRoot } from './workspace-resolver.js'

export async function runDoctor(): Promise<{ ok: boolean; lines: string[] }> {
  const logger = createStderrLogger()
  const lines: string[] = []
  let ok = true

  const { root, source } = resolveWorkspaceRoot(process.env.CONTEXT_MILVUS_WORKSPACE)
  lines.push(`workspace: ${root} (source=${source})`)

  const config = getConfig({ indexRoot: root })
  lines.push(`milvus: ${config.milvusAddress} collection=${config.milvusCollection} dim=${config.milvusDim}`)
  lines.push(`embedding: ${config.embedding.endpoint} model=${config.embedding.model}`)

  const configFile = path.join(root, '.codex', 'config.toml')
  lines.push(`project config: ${existsSync(configFile) ? configFile : '未找到（可运行 init 生成）'}`)

  try {
    const embedding = new EmbeddingClient(config.embedding)
    const vectors = await embedding.embed(['doctor connectivity probe'])
    lines.push(`embedding probe: ok (dim=${vectors[0]?.length ?? 0})`)
  } catch (err) {
    ok = false
    lines.push(`embedding probe: FAILED — ${(err as Error).message}`)
  }

  try {
    const milvus = new MilvusService({
      address: config.milvusAddress, token: config.milvusToken,
      collection: config.milvusCollection, dim: config.milvusDim,
      embeddingClient: new EmbeddingClient(config.embedding),
      logger,
    })
    await milvus.ensureCollection()
    lines.push('milvus probe: ok')
  } catch (err) {
    ok = false
    lines.push(`milvus probe: FAILED — ${(err as Error).message}`)
  }

  return { ok, lines }
}
