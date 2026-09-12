import { jest } from '@jest/globals'
const { chunkAdrFile } = await import('../src/plugins/dsh-context-milvus/adr-chunker.js')

describe('chunkAdrFile', () => {
  const sampleAdr = `---
id: ADR-0001-test
type: decision-record
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors:
  - file: src/test.ts
    symbols: [Test]
    lines: [1, 10]
    git_commit: abc
trigger:
  task_id: null
  requirement_summary: "Test"
  change_type: refactor
related_decisions: []
auto_generated: false
---

## 决策目标

This is the goal of the decision.

## 约束条件

- Constraint 1
- Constraint 2

## 候选方案与权衡

### 方案A：Option A
- Description of A
- **放弃原因**: Not chosen

### 方案B：Option B（✅ 选用）
- Description of B
- **选择原因**: Best fit

## 关键设计细节与隐性约束

### 隐性约束1：Performance
- **内容**: Must be fast
- **原因**: User-facing
- **如果破坏会怎样**: Latency issues

## 被否决的模式/反模式

- ❌ Anti-pattern A — dangerous

## 相关测试

- test/file.test.ts

## 变更边界

- When count > 1000, reconsider
`

  it('splits ADR into sections by ## headings', async () => {
    const chunks = await chunkAdrFile('/docs/decisions/ADR-0001-test.md', sampleAdr)
    expect(chunks.length).toBeGreaterThanOrEqual(7)
    // Check sections exist
    const sections = chunks.map(c => c.section)
    expect(sections).toContain('goal')
    expect(sections).toContain('constraints')
    expect(sections).toContain('alternatives')
    expect(sections).toContain('hidden_constraints')
    expect(sections).toContain('rejected')
    expect(sections).toContain('tests')
    expect(sections).toContain('boundary')
  })

  it('sets adrId and filePath on each chunk', async () => {
    const chunks = await chunkAdrFile('/docs/decisions/ADR-0001-test.md', sampleAdr)
    for (const chunk of chunks) {
      expect(chunk.adrId).toBe('ADR-0001-test')
      expect(chunk.filePath).toBe('/docs/decisions/ADR-0001-test.md')
    }
  })

  it('sets docType to "adr" on each chunk', async () => {
    const chunks = await chunkAdrFile('/docs/decisions/ADR-0001-test.md', sampleAdr)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.docType).toBe('adr')
    }
  })

  it('sets status and triggerType from frontmatter', async () => {
    const chunks = await chunkAdrFile('/docs/decisions/ADR-0001-test.md', sampleAdr)
    for (const chunk of chunks) {
      expect(chunk.status).toBe('active')
      expect(chunk.triggerType).toBe('refactor')
    }
  })

  it('sets codeAnchors from frontmatter', async () => {
    const chunks = await chunkAdrFile('/docs/decisions/ADR-0001-test.md', sampleAdr)
    for (const chunk of chunks) {
      expect(chunk.codeAnchors).toContain('src/test.ts')
    }
  })

  it('returns empty array for content without frontmatter', async () => {
    const chunks = await chunkAdrFile('/test.md', '# No frontmatter')
    expect(chunks).toEqual([])
  })

  // --- Spec/plan section tests ---

  const specContent = `---
id: SPEC-2026-09-02-test
type: spec
status: active
created: 2026-09-02
updated: 2026-09-02
author: test
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "test"
  change_type: architecture
related_decisions: []
auto_generated: true
---

# Test Spec

## Context

This is the context section.

## Architecture decisions

This is the decisions section.
`

  const planContent = `---
id: PLAN-2026-09-02-test
type: plan
status: active
created: 2026-09-02
updated: 2026-09-02
author: test
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "test"
  change_type: architecture
related_decisions: []
auto_generated: true
---

# Test Plan

## Scope

This is the scope section.

## Implementation

This is the implementation section.
`

  it('maps English section names correctly for spec content', async () => {
    const chunks = await chunkAdrFile('/docs/specs/SPEC-2026-09-02-test.md', specContent)
    const sections = chunks.map(c => c.section)
    expect(sections).toContain('context')
    expect(sections).toContain('decisions')
  })

  it('sets docType to "spec" for spec frontmatter', async () => {
    const chunks = await chunkAdrFile('/docs/specs/SPEC-2026-09-02-test.md', specContent)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.docType).toBe('spec')
    }
  })

  it('sets docType to "plan" for plan frontmatter', async () => {
    const chunks = await chunkAdrFile('/docs/plans/PLAN-2026-09-02-test.md', planContent)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.docType).toBe('plan')
    }
  })

  it('maps English section names correctly for plan content', async () => {
    const chunks = await chunkAdrFile('/docs/plans/PLAN-2026-09-02-test.md', planContent)
    const sections = chunks.map(c => c.section)
    expect(sections).toContain('scope')
    expect(sections).toContain('implementation')
  })

  it('defaults docType to "adr" for decision-record frontmatter', async () => {
    const chunks = await chunkAdrFile('/docs/decisions/ADR-0001-test.md', sampleAdr)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.docType).toBe('adr')
    }
  })

  it('defaults docType to "adr" for unrecognized frontmatter type', async () => {
    const unknownContent = sampleAdr.replace('type: decision-record', 'type: notes')
    const chunks = await chunkAdrFile('/docs/notes/notes.md', unknownContent)
    expect(chunks.length).toBeGreaterThan(0)
    for (const chunk of chunks) {
      expect(chunk.docType).toBe('adr')
    }
  })

  it('passes unmatched headings through as-is', async () => {
    const content = `---
id: ADR-0002-test
type: decision-record
status: active
created: 2026-09-02
updated: 2026-09-02
author: test
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "test"
  change_type: refactor
related_decisions: []
auto_generated: false
---

# Test

## Custom Section

This is a custom section not in the map.
`
    const chunks = await chunkAdrFile('/docs/test.md', content)
    expect(chunks.length).toBe(1)
    expect(chunks[0].section).toBe('Custom Section')
  })
})
