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
})
