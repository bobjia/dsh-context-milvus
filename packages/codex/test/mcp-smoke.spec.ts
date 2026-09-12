import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../bin/mcp.js')

function rpc(child: any, id: number, method: string, params: unknown) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
}

describe('mcp stdio smoke', () => {
  it('lists the five tools', async () => {
    const child = spawn(process.execPath, [BIN], { stdio: ['pipe', 'pipe', 'pipe'] })
    const lines: string[] = []
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(line)
    })

    rpc(child, 1, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'smoke', version: '1.0.0' },
    })
    const deadline = Date.now() + 10000
    while (!lines.some(l => l.includes('"id":1')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    const init = JSON.parse(lines.find(l => l.includes('"id":1'))!)
    expect(init.result.serverInfo.name).toBe('codex-context-milvus')

    rpc(child, 2, 'notifications/initialized', {})
    rpc(child, 3, 'tools/list', {})
    while (!lines.some(l => l.includes('"id":3')) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 50))
    }
    const list = JSON.parse(lines.find(l => l.includes('"id":3'))!)
    const names = list.result.tools.map((t: any) => t.name).sort()
    expect(names).toEqual(['find_callers', 'index_code', 'index_status', 'search_code', 'trace_call_chain'])

    child.kill()
    await once(child, 'exit').catch(() => {})
  }, 20000)
})
