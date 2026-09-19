#!/usr/bin/env node
/**
 * Standalone indexing entry point for dsh-context-milvus.
 *
 * The plugin never runs heavy indexing inline on a large workspace; it hands
 * the user a command that runs this script in their own terminal instead, where
 * no session timeout applies and Ctrl-C is safe (the Merkle tracker is
 * checkpointed as it goes).
 */
import { runIndexCli } from 'dsh-context-milvus-core'

process.exitCode = await runIndexCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
})
