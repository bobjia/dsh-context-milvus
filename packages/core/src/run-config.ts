/**
 * Per-workspace run-config written by the DSH plugin when index_code or
 * index_specs defers a large corpus, and read by the standalone index CLI.
 *
 * It carries the *resolved* PluginConfig so the script uses exactly the same
 * Milvus/embedding settings as the running plugin, instead of re-deriving them
 * from environment variables and risking a mismatch.
 *
 * The payload includes the Milvus token and the embedding API key, so the file
 * is written 0600.
 */
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import * as path from 'node:path'
import { deriveRunConfigPath, type PluginConfig } from './config.js'

export interface RunConfigFile {
  version: 1
  generatedAt: string
  config: PluginConfig
}

const CURRENT_VERSION = 1

/** Write the resolved config next to the workspace's Merkle state. Returns the path. */
export async function writeRunConfig(config: PluginConfig): Promise<string> {
  const filePath = deriveRunConfigPath(config.indexRoot)
  await mkdir(path.dirname(filePath), { recursive: true })

  const payload: RunConfigFile = {
    version: CURRENT_VERSION,
    generatedAt: new Date().toISOString(),
    config,
  }

  await writeFile(filePath, JSON.stringify(payload, null, 2), { encoding: 'utf-8', mode: 0o600 })
  // writeFile only applies `mode` when creating; tighten a pre-existing file too.
  await chmod(filePath, 0o600)
  return filePath
}

/** Read a run-config. Returns null when missing, corrupt or of another version. */
export async function readRunConfig(filePath: string): Promise<RunConfigFile | null> {
  try {
    const parsed = JSON.parse(await readFile(filePath, 'utf-8')) as RunConfigFile
    if (parsed?.version !== CURRENT_VERSION) return null
    if (!parsed.config || typeof parsed.config.indexRoot !== 'string') return null
    return parsed
  } catch {
    return null
  }
}
