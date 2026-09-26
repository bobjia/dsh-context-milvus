import * as path from 'node:path'
import type { PluginConfig } from 'dsh-context-milvus-core'

/**
 * 按优先级解析工具运行时使用的工作区根路径。
 *
 * 1. explicitPath — 用户显式传入（最高优先级）
 * 2. exec.agent.session.header.cwd — 当前 DSH 会话的工作区根
 * 3. config.indexRoot — Cordis 配置 / 环境变量 / DSH GUI 设置
 * 4. startupCwd — 插件启动时的 process.cwd()（DSH 服务进程 cwd）
 * 5. process.cwd() — 启动 cwd 拿不到时的兜底
 *
 * **相对 explicitPath 会先锚定到 2–5 级算出的基准根，再返回。**
 * 原因：返回值在下游被当作 `file_path like "<root>%"` 的前缀。存储的
 * `file_path` 恒为绝对路径，未绝对化的相对串永远匹配不到，检索会静默返回
 * 零结果（而不是报错），调用方无从察觉路径写错。codex 适配器的
 * `workspace-resolver.ts` 一直用 `path.resolve(cwd, explicitPath)`，此处对齐。
 */
export function resolveWorkspaceRoot(
  config: PluginConfig,
  exec: { agent?: { session?: { header?: { cwd?: string } } } } | undefined,
  startupCwd: string,
  explicitPath?: string,
): string {
  const sessionCwd = exec?.agent?.session?.header?.cwd
  const base = sessionCwd || config.indexRoot || startupCwd || process.cwd()
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(base, explicitPath)
  }
  return base
}
