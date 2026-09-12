import { spawn } from 'node:child_process'
import { once } from 'node:events'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = path.resolve(HERE, '../bin/mcp.js')

function rpc(child: any, id: number, method: string, params: unknown) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
}

async function listToolNames(env: Record<string, string>): Promise<string[]> {
  const child = spawn(process.execPath, [BIN], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const lines: string[] = []
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split('\n')) if (line.trim()) lines.push(line)
  })
  const deadline = Date.now() + 15000

  rpc(child, 1, 'initialize', {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '1.0.0' },
  })
  while (!lines.some((l) => l.includes('"id":1')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const init = JSON.parse(lines.find((l) => l.includes('"id":1'))!)
  expect(init.result.serverInfo.name).toBe('codex-context-milvus')

  rpc(child, 2, 'notifications/initialized', {})
  rpc(child, 3, 'tools/list', {})
  while (!lines.some((l) => l.includes('"id":3')) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 50))
  }
  const list = JSON.parse(lines.find((l) => l.includes('"id":3'))!)

  child.kill()
  await once(child, 'exit').catch(() => {})
  return list.result.tools.map((t: any) => t.name).sort()
}

const CORE_TOOLS = ['find_callers', 'index_code', 'index_status', 'search_code', 'trace_call_chain']

describe('mcp stdio smoke', () => {
  it('lists the five core tools when ADR is off', async () => {
    expect(await listToolNames({ ADR_ENABLED: '' })).toEqual(CORE_TOOLS)
  }, 20000)

  // The ADR branch also proves bundle assembly needs no live Milvus: with
  // ADR_ENABLED on, tools/list still answers.
  // Write tools are registered too: the write gate refuses at call time rather
  // than hiding a tool the user has switched on.
  it('lists all thirteen tools once ADR_ENABLED is set', async () => {
    expect(await listToolNames({ ADR_ENABLED: 'true' })).toEqual([
      ...CORE_TOOLS,
      'check_adr_consistency', 'create_adr', 'index_specs', 'list_adrs',
      'load_constraints', 'search_adr', 'search_adr_by_file', 'update_adr',
    ].sort())
  }, 20000)
})
