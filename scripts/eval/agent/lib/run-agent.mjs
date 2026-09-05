import { spawn } from 'node:child_process'

// 调用一次 driver，解析 stdout 末行 JSON：{ passed, tokens, toolCalls, durationMs }。
export function runAgentOnce({ driver, task, group, root }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [driver, '--task', task.id, '--group', group, '--root', root], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', () => {})
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`driver exited ${code}: ${out.trim()}`))
      try {
        const line = out.trim().split('\n').pop()
        const parsed = JSON.parse(line)
        if (typeof parsed.passed !== 'boolean' || typeof parsed.tokens !== 'number') {
          throw new Error('missing fields')
        }
        resolve(parsed)
      } catch (e) {
        reject(new Error(`driver bad output: ${out.trim()}`))
      }
    })
  })
}
