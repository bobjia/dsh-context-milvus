/**
 * 本地遥测：工具执行指标写入 JSONL（默认关闭，opt-in）。
 * 只记录查询文本与统计量，不采集源代码内容。
 */
import { mkdir, appendFile } from 'node:fs/promises'
import * as path from 'node:path'

export interface TelemetryEntry {
  ts: string
  tool: string
  [key: string]: unknown
}

export interface TelemetryConfig {
  telemetryEnabled: boolean
  telemetryFile: string
}

export interface Telemetry {
  log: (entry: TelemetryEntry) => void
  flush: () => Promise<void>
}

/** 配置快照每次调用实时解析，GUI 修改后无需重载即生效。 */
export function createTelemetry(resolveConfig: () => TelemetryConfig): Telemetry {
  let queue: Promise<void> = Promise.resolve()
  return {
    log(entry) {
      const cfg = resolveConfig()
      if (!cfg.telemetryEnabled || !cfg.telemetryFile) return
      const line = JSON.stringify(entry)
      queue = queue.then(async () => {
        try {
          await mkdir(path.dirname(cfg.telemetryFile), { recursive: true })
          await appendFile(cfg.telemetryFile, line + '\n', 'utf-8')
        } catch {
          // 遥测失败不影响业务执行
        }
      })
    },
    flush: () => queue,
  }
}

/** 查询文本脱敏：去控制字符 + 截断，防止日志注入与超长条目。 */
export function sanitizeQuery(q: unknown): string {
  return String(q ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .trim()
    .slice(0, 200)
}
