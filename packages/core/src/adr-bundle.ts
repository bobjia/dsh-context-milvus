import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { AdrAnchorIndex } from './adr-anchor-index.js'
import { AdrService } from './adr-service.js'
import { HashTracker } from './merkle.js'
import { deriveAdrTrackerPath, deriveAnchorIndexPath } from './config.js'
import type { Logger } from './logger.js'
import type { PluginConfig } from './config.js'

export interface AdrTitle {
  title: string
  status: string
}

/**
 * Everything one workspace needs to work with ADR decision records.
 *
 * Both adapters build their bundle through this function so the ADR root
 * resolution and the state file locations cannot drift apart between DSH and
 * the MCP server: an ADR created in one is readable in the other.
 */
export interface AdrBundle {
  /** Absolute path of the ADR directory. */
  adrRoot: string
  /** Whether that directory exists. Never created implicitly. */
  exists: boolean
  service: AdrService
  anchorIndex: AdrAnchorIndex
  tracker: HashTracker
  /** adrId → title/status, read once and cached for this bundle. */
  titles(): Promise<Map<string, AdrTitle>>
}

/**
 * Assemble the ADR services for one workspace.
 *
 * Deliberately free of any network call: state files are read from disk and
 * the Milvus ADR collection is only ensured by the callers that need it. That
 * keeps tool discovery testable without a live Milvus.
 *
 * Logging is opt-in (no console default) so wiring an ADR bundle never adds
 * output a caller did not ask for.
 *
 * `createWhenMissing` defaults to false: loading this bundle must not grow a
 * docs/decisions tree inside someone's repository. The DSH plugin passes true to
 * keep its historical behaviour of creating the ADR root at startup.
 */
export async function createAdrBundle(
  config: PluginConfig,
  options?: { logger?: Logger; createWhenMissing?: boolean },
): Promise<AdrBundle> {
  const logger = options?.logger
  const adrRoot = path.resolve(config.indexRoot, config.adrRoot || 'docs/decisions')

  const anchorIndex = new AdrAnchorIndex(deriveAnchorIndexPath(adrRoot))
  await anchorIndex.load().catch(() => {})

  const service = new AdrService(adrRoot, { createWhenMissing: options?.createWhenMissing ?? false })

  const tracker = new HashTracker(deriveAdrTrackerPath(adrRoot))
  await tracker.load().catch(() => {})

  let cached: Map<string, AdrTitle> | null = null
  const titles = async (): Promise<Map<string, AdrTitle>> => {
    if (cached) return cached
    const map = new Map<string, AdrTitle>()
    try {
      for (const item of await service.listAdrs({ status: 'all', limit: 10000 })) {
        map.set(item.id, { title: item.summary, status: item.status })
      }
    } catch (err) {
      logger?.debug('ADR titles unavailable', { adrRoot, error: String(err) })
    }
    cached = map
    return map
  }

  const bundle: AdrBundle = { adrRoot, exists: existsSync(adrRoot), service, anchorIndex, tracker, titles }
  logger?.debug('ADR bundle ready', { adrRoot, exists: bundle.exists })
  return bundle
}
