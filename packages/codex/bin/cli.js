#!/usr/bin/env node
const [command] = process.argv.slice(2)

async function main() {
  if (command === 'mcp') {
    const { main: runMcp } = await import('../dist/server.js')
    return runMcp()
  }
  if (command === 'init') {
    const { runInitCli } = await import('../dist/cli.js')
    return runInitCli(process.argv.slice(3))
  }
  if (command === 'doctor') {
    const { runDoctor } = await import('../dist/doctor.js')
    const { ok, lines } = await runDoctor()
    for (const line of lines) console.error(line)
    process.exit(ok ? 0 : 1)
  }
  console.error('用法: codex-context-milvus <mcp|init|doctor>')
  process.exit(2)
}

main().catch((err) => {
  console.error('[codex-context-milvus] fatal:', err)
  process.exit(1)
})
