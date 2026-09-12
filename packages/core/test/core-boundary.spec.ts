import { jest } from '@jest/globals'
import { readFileSync, readdirSync } from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '../src')
const FORBIDDEN = [/@deepseek-ai\//, /@modelcontextprotocol\//, /from 'zod'/, /from "zod"/]

describe('core boundary', () => {
  it('does not import DSH, MCP or zod', () => {
    const offenders: string[] = []
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith('.ts')) continue
      const text = readFileSync(path.join(SRC, file), 'utf-8')
      for (const pattern of FORBIDDEN) {
        if (pattern.test(text)) offenders.push(`${file}: ${pattern}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('does not call console.log directly', () => {
    const offenders: string[] = []
    for (const file of readdirSync(SRC)) {
      if (!file.endsWith('.ts') || file === 'logger.ts') continue
      const text = readFileSync(path.join(SRC, file), 'utf-8')
      if (/console\.(log|warn|info)\(/.test(text)) offenders.push(file)
    }
    expect(offenders).toEqual([])
  })
})
