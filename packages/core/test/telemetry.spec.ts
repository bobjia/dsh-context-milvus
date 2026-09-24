import { describe, expect, test } from '@jest/globals'
import { mkdtemp, readFile, rm, stat, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

describe('telemetry', () => {
  test('sanitizeQuery strips control chars and truncates', async () => {
    const { sanitizeQuery } = await import('../src/telemetry.js')
    expect(sanitizeQuery('a\nb\u0000c')).toBe('a b c')
    expect(sanitizeQuery('x'.repeat(500)).length).toBeLessThanOrEqual(200)
  })

  test('createTelemetry disabled writes nothing', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tel-'))
    const file = path.join(dir, 't.jsonl')
    const { createTelemetry } = await import('../src/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: false, telemetryFile: file }))
    tel.log({ ts: new Date().toISOString(), tool: 'search_code', query: 'q' })
    await tel.flush()
    await expect(readFile(file, 'utf-8')).rejects.toThrow()
    await rm(dir, { recursive: true, force: true })
  })

  test('createTelemetry enabled appends JSONL lines', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tel-'))
    const file = path.join(dir, 't.jsonl')
    const { createTelemetry } = await import('../src/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: true, telemetryFile: file }))
    tel.log({ ts: '2026-01-01T00:00:00.000Z', tool: 'search_code', query: 'auth', resultCount: 3 })
    tel.log({ ts: '2026-01-01T00:00:01.000Z', tool: 'index_status', totalFiles: 10 })
    await tel.flush()
    const text = await readFile(file, 'utf-8')
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]).tool).toBe('search_code')
    expect(JSON.parse(lines[1]).tool).toBe('index_status')
    await rm(dir, { recursive: true, force: true })
  })

  test('log failures are swallowed (bad dir)', async () => {
    const { createTelemetry } = await import('../src/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: true, telemetryFile: '/nonexistent-dir-xyz/t.jsonl' }))
    tel.log({ ts: new Date().toISOString(), tool: 'search_code', query: 'q' })
    await tel.flush()
    expect(true).toBe(true)
  })

  // POSIX file modes are not enforceable on Windows — Node always reports 0666.
  const skipModeOnWin = process.platform === 'win32' ? test.skip : test

  skipModeOnWin('creates the telemetry file with mode 0600', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tel-'))
    const file = path.join(dir, 't.jsonl')
    const { createTelemetry } = await import('../src/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: true, telemetryFile: file }))
    tel.log({ ts: '2026-01-01T00:00:00.000Z', tool: 'search_code', query: 'auth' })
    await tel.flush()
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await rm(dir, { recursive: true, force: true })
  })

  skipModeOnWin('tightens a pre-existing 0644 telemetry file to 0600', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'tel-'))
    const file = path.join(dir, 't.jsonl')
    await writeFile(file, '', { encoding: 'utf-8', mode: 0o644 })
    await chmod(file, 0o644)
    const { createTelemetry } = await import('../src/telemetry.js')
    const tel = createTelemetry(() => ({ telemetryEnabled: true, telemetryFile: file }))
    tel.log({ ts: '2026-01-01T00:00:00.000Z', tool: 'search_code', query: 'auth' })
    await tel.flush()
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    await rm(dir, { recursive: true, force: true })
  })
})
