#!/usr/bin/env node
import { main } from '../dist/server.js'

main().catch((err) => {
  console.error('[codex-context-milvus] fatal:', err)
  process.exit(1)
})
