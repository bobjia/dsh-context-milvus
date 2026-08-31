import { jest } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

const { parseFrontmatter } = await import('../src/plugins/dsh-context-milvus/adr-frontmatter.js')

describe('parseFrontmatter', () => {
  const sampleAdr = `---
id: ADR-0001-decision-memory-system
type: decision-record
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: human
supersedes: null
superseded_by: null
code_anchors:
  - file: src/webhook/dispatcher.ts
    symbols:
      - WebhookDispatcher
    lines:
      - 45
      - 120
    git_commit: abc123
trigger:
  task_id: null
  requirement_summary: "Deploy decision causal memory system"
  change_type: architecture
related_decisions:
  - ADR-0002
auto_generated: false
---

## 决策目标

Test

## 约束条件

Test constraint
`

  it('parses a complete ADR frontmatter', () => {
    const result = parseFrontmatter(sampleAdr)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('ADR-0001-decision-memory-system')
    expect(result!.status).toBe('active')
    expect(result!.code_anchors).toHaveLength(1)
    expect(result!.code_anchors[0].file).toBe('src/webhook/dispatcher.ts')
    expect(result!.code_anchors[0].symbols).toEqual(['WebhookDispatcher'])
    expect(result!.trigger.requirement_summary).toBe('Deploy decision causal memory system')
    expect(result!.trigger.change_type).toBe('architecture')
    expect(result!.related_decisions).toEqual(['ADR-0002'])
    expect(result!.auto_generated).toBe(false)
  })

  it('returns null when no frontmatter found', () => {
    expect(parseFrontmatter('# Just a heading')).toBeNull()
  })

  it('returns null for empty content', () => {
    expect(parseFrontmatter('')).toBeNull()
  })

  it('parses frontmatter with null fields', () => {
    const minimal = `---
id: ADR-0002-test
type: decision-record
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: agent
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Minimal test"
  change_type: refactor
related_decisions: []
auto_generated: true
---

Body`
    const result = parseFrontmatter(minimal)
    expect(result).not.toBeNull()
    expect(result!.id).toBe('ADR-0002-test')
    expect(result!.code_anchors).toEqual([])
    expect(result!.auto_generated).toBe(true)
  })
})
