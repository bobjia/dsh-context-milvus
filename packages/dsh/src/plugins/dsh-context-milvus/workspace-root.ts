import type { PluginConfig } from 'dsh-context-milvus-core'

/**
 * 按优先级解析工具运行时使用的工作区根路径。
 *
 * 1. explicitPath — 用户显式传入（最高优先级）
 * 2. exec.agent.session.header.cwd — 当前 DSH 会话的工作区根
 * 3. config.indexRoot — Cordis 配置 / 环境变量 / DSH GUI 设置
 * 4. startupCwd — 插件启动时的 process.cwd()（DSH 服务进程 cwd）
 * 5. process.cwd() — 启动 cwd 拿不到时的兜底
 */
export function resolveWorkspaceRoot(
  config: PluginConfig,
  exec: { agent?: { session?: { header?: { cwd?: string } } } } | undefined,
  startupCwd: string,
  explicitPath?: string,
): string {
  if (explicitPath) return explicitPath
  const sessionCwd = exec?.agent?.session?.header?.cwd
  if (sessionCwd) return sessionCwd
  if (config.indexRoot) return config.indexRoot
  return startupCwd || process.cwd()
}
