# Decision Causal Memory System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the `dsh-context-milvus` DSH plugin with ADR (Architecture Decision Record) indexing, search, CRUD, code_anchors cross-referencing, constraint re-injection, and system prompt injection — turning it from a "code search" plugin into a "decision causal memory" system.

**Architecture:** Incremental extension — keep existing code search untouched, add 7 new modules (adr-frontmatter, adr-chunker, adr-anchor-index, adr-service, adr-indexer, adr-tools, constraint-injector) and extend 5 existing files (index.ts, config.ts, types.ts, tools.ts, milvus-service.ts). ADRs stored in a separate Milvus collection `adr_embeddings` with hybrid BM25+vector search. code_anchors reverse index maintained as JSON sidecar for O(1) deterministic lookup. System prompt injection via `ctx.systemPrompt.section()`, constraint re-injection via `agent/pre-step` hook.

**Tech Stack:** TypeScript, DSH Cordis plugin, `@zilliz/milvus2-sdk-node`, `js-yaml` (MIT, for YAML frontmatter parsing), Jest (ESM mode with `unstable_mockModule`).

## Global Constraints

- All new code must follow existing patterns: `defineTool()` for tools, `jest.unstable_mockModule` for testing, ESM imports throughout
- No breaking changes to existing tools (`search_code`, `index_code`, `index_status`) or their output schemas
- ADR Milvus collection must use the same embedding dimension (`milvusDim`) and hybrid search pattern as the code collection
- ADR files must follow the `ADR-{4位序号}-{kebab-case描述}.md` naming convention
- `docs/decisions/` is the default ADR directory, configurable via `adrRoot` (relative to `indexRoot`)
- Constraint re-injection default interval: 5 steps (configurable, 0 = disabled)
- All new config fields must have env var fallbacks

---
### Task 1: Dependencies, Config & Types

**Files:**
- Modify: `package.json`
- Modify: `src/plugins/dsh-context-milvus/config.ts`
- Modify: `src/plugins/dsh-context-milvus/types.ts`
- Create: `test/adr-types.spec.ts`

**Interfaces:**
- Consumes: existing `CordisConfig`, `PluginConfig`, `CodeChunk`, `SearchResult` types
- Produces: `AdrConfig` fields, `AdrFrontmatter`, `AdrCodeAnchor`, `AdrTrigger`, `AdrChunk`, `AdrSearchResult`, `AdrListItem`, `ConstraintSummary`, `AdrIndexStatus`

- [ ] **Step 1: Add dependencies**

Run: `npm install js-yaml`
Run: `npm install --save-dev @types/js-yaml`
Run: `npm install --save-dev @deepseek-ai/dsh-llm`  (for `createUserMessage` in Task 9; DSH runtime provides it at runtime)

- [ ] **Step 2: Add ADR types to `types.ts`**

```typescript
// src/plugins/dsh-context-milvus/types.ts — append after existing types

/** ADR code anchor — links a decision to a code location */
export interface AdrCodeAnchor {
  file: string
  symbols: string[]
  lines: [number, number]
  git_commit: string
}

/** ADR trigger — the requirement that drove this decision */
export interface AdrTrigger {
  task_id: string | null
  requirement_summary: string
  change_type: string
}

/** Parsed ADR frontmatter */
export interface AdrFrontmatter {
  id: string
  type: string
  status: 'active' | 'superseded' | 'deprecated'
  created: string
  updated: string
  author: string
  supersedes: string | null
  superseded_by: string | null
  code_anchors: AdrCodeAnchor[]
  trigger: AdrTrigger
  related_decisions: string[]
  auto_generated: boolean
  confidence_levels?: Record<string, string>
}

/** ADR section chunk (extends CodeChunk with ADR-specific fields) */
export interface AdrChunk {
  filePath: string
  adrId: string
  section: string
  content: string
  startLine: number
  endLine: number
  status: string
  codeAnchors: string[]
  triggerType: string
}

/** ADR search result */
export interface AdrSearchResult {
  adrId: string
  filePath: string
  status: string
  section: string
  content: string
  score: number
  triggerType: string
  codeAnchors: string[]
}

/** ADR list item (for list_adrs tool) */
export interface AdrListItem {
  id: string
  filePath: string
  status: string
  created: string
  updated: string
  anchorCount: number
  summary: string
  changeType: string
}

/** Constraint summary (for load_constraints and re-injection) */
export interface ConstraintSummary {
  adrId: string
  adrTitle: string
  constraints: string[]
  hiddenConstraints: Array<{ name: string; content: string; consequence: string }>
  rejectedPatterns: string[]
  status: string
}

/** ADR index status */
export interface AdrIndexStatus {
  totalAdrs: number
  totalChunks: number
  lastIndexed: string
  activeAdrs: number
}

/** ADR filter params */
export interface AdrFilter {
  status?: string
  changeType?: string
  limit?: number
}

/** Create ADR params */
export interface CreateAdrParams {
  title: string
  requirement?: string
  changeType?: string
  supersedes?: string
  content?: string
}

/** Update ADR params */
export interface UpdateAdrParams {
  content?: string
  status?: string
  supersededBy?: string
  merge?: boolean
}

/** ADR document (fully parsed) */
export interface AdrDocument {
  frontmatter: AdrFrontmatter
  sections: Record<string, string>
  rawContent: string
  filePath: string
}

/** ADR anchor index stats */
export interface AnchorIndexStats {
  adrCount: number
  anchorCount: number
}
```

- [ ] **Step 3: Add ADR config fields to `config.ts`**

In `CordisConfig` interface, add:
```typescript
/** Enable ADR (decision memory) features */
adrEnabled?: boolean
/** ADR directory relative to indexRoot */
adrRoot?: string
/** Milvus collection name for ADR embeddings */
adrCollection?: string
/** Steps between constraint re-injection (0=disable) */
adrConstraintReinjectEvery?: number
/** Custom system prompt section for ADR rules (empty=use default) */
adrSystemPrompt?: string
```

In `PluginConfig` interface, add:
```typescript
adrEnabled: boolean
adrRoot: string
adrCollection: string
adrConstraintReinjectEvery: number
adrSystemPrompt: string
```

In `getConfig()` function, add resolution:
```typescript
return {
  // ...existing fields...
  adrEnabled: overrides?.adrEnabled !== undefined
    ? overrides.adrEnabled
    : process.env.ADR_ENABLED !== 'false',
  adrRoot: overrides?.adrRoot ?? process.env.ADR_ROOT ?? 'docs/decisions',
  adrCollection: overrides?.adrCollection ?? process.env.ADR_COLLECTION ?? 'adr_embeddings',
  adrConstraintReinjectEvery: (() => {
    const raw = overrides?.adrConstraintReinjectEvery ?? parseInt(process.env.ADR_REINJECT_EVERY ?? '', 10)
    return !isNaN(raw) && raw >= 0 ? raw : 5
  })(),
  adrSystemPrompt: overrides?.adrSystemPrompt ?? process.env.ADR_SYSTEM_PROMPT ?? '',
}
```

- [ ] **Step 4: Write config test**

```typescript
// test/adr-types.spec.ts — config resolution tests
import { jest } from '@jest/globals'
const { getConfig } = await import('../src/plugins/dsh-context-milvus/config.js')

describe('ADR config', () => {
  const OLD_ENV = process.env
  beforeEach(() => {
    process.env = { ...OLD_ENV }
    delete process.env.ADR_ENABLED
    delete process.env.ADR_ROOT
    delete process.env.ADR_COLLECTION
    delete process.env.ADR_REINJECT_EVERY
  })
  afterAll(() => { process.env = OLD_ENV })

  it('defaults adrEnabled to true', () => {
    expect(getConfig().adrEnabled).toBe(true)
  })

  it('reads adrRoot from env', () => {
    process.env.ADR_ROOT = 'decisions'
    expect(getConfig().adrRoot).toBe('decisions')
  })

  it('defaults adrCollection to adr_embeddings', () => {
    expect(getConfig().adrCollection).toBe('adr_embeddings')
  })

  it('defaults adrConstraintReinjectEvery to 5', () => {
    expect(getConfig().adrConstraintReinjectEvery).toBe(5)
  })

  it('reads adrConstraintReinjectEvery from env', () => {
    process.env.ADR_REINJECT_EVERY = '10'
    expect(getConfig().adrConstraintReinjectEvery).toBe(10)
  })

  it('Cordis config overrides env', () => {
    process.env.ADR_ENABLED = 'false'
    expect(getConfig({ adrEnabled: true }).adrEnabled).toBe(true)
  })
})
```

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx jest test/adr-types.spec.ts -v`
Expected: Tests fail because config.ts doesn't yet have the ADR fields

- [ ] **Step 6: Implement config changes**

Apply the changes from Step 3 to `src/plugins/dsh-context-milvus/config.ts`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx jest test/adr-types.spec.ts -v`
Expected: All 6 tests PASS

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json test/adr-types.spec.ts src/plugins/dsh-context-milvus/types.ts src/plugins/dsh-context-milvus/config.ts
git commit -m "feat: add ADR types, config fields, and js-yaml dependency"
```

---
### Task 2: ADR Frontmatter Parser

**Files:**
- Create: `src/plugins/dsh-context-milvus/adr-frontmatter.ts`
- Create: `test/adr-frontmatter.spec.ts`

**Interfaces:**
- Consumes: `AdrFrontmatter`, `AdrCodeAnchor`, `AdrTrigger` types
- Produces: `parseFrontmatter(content: string): AdrFrontmatter | null`

- [ ] **Step 1: Write the failing test**

```typescript
// test/adr-frontmatter.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/adr-frontmatter.spec.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `adr-frontmatter.ts`**

```typescript
// src/plugins/dsh-context-milvus/adr-frontmatter.ts
import { load as yamlLoad } from 'js-yaml'
import type { AdrFrontmatter, AdrCodeAnchor, AdrTrigger } from './types.js'

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/

/**
 * Parse YAML frontmatter from an ADR markdown file.
 * Returns null if no valid frontmatter is found.
 */
export function parseFrontmatter(content: string): AdrFrontmatter | null {
  if (!content) return null

  const match = FRONTMATTER_PATTERN.exec(content)
  if (!match) return null

  try {
    const raw = yamlLoad(match[1]) as Record<string, unknown>
    if (!raw || typeof raw.id !== 'string') return null

    // Parse code_anchors
    const codeAnchors: AdrCodeAnchor[] = []
    if (Array.isArray(raw.code_anchors)) {
      for (const anchor of raw.code_anchors) {
        if (anchor && typeof anchor === 'object') {
          const a = anchor as Record<string, unknown>
          codeAnchors.push({
            file: String(a.file ?? ''),
            symbols: Array.isArray(a.symbols) ? a.symbols.map(String) : [],
            lines: Array.isArray(a.lines) && a.lines.length === 2
              ? [Number(a.lines[0]), Number(a.lines[1])] as [number, number]
              : [0, 0],
            git_commit: String(a.git_commit ?? ''),
          })
        }
      }
    }

    // Parse trigger
    const triggerRaw = (raw.trigger ?? {}) as Record<string, unknown>
    const trigger: AdrTrigger = {
      task_id: triggerRaw.task_id != null ? String(triggerRaw.task_id) : null,
      requirement_summary: String(triggerRaw.requirement_summary ?? ''),
      change_type: String(triggerRaw.change_type ?? ''),
    }

    // Parse related_decisions
    const relatedDecisions: string[] = Array.isArray(raw.related_decisions)
      ? raw.related_decisions.map(String)
      : []

    return {
      id: String(raw.id),
      type: String(raw.type ?? 'decision-record'),
      status: (raw.status === 'superseded' || raw.status === 'deprecated') ? raw.status : 'active',
      created: String(raw.created ?? ''),
      updated: String(raw.updated ?? ''),
      author: String(raw.author ?? ''),
      supersedes: raw.supersedes && raw.supersedes !== 'null' ? String(raw.supersedes) : null,
      superseded_by: raw.superseded_by && raw.superseded_by !== 'null' ? String(raw.superseded_by) : null,
      code_anchors: codeAnchors,
      trigger,
      related_decisions: relatedDecisions,
      auto_generated: raw.auto_generated === true,
    }
  } catch {
    return null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/adr-frontmatter.spec.ts -v`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/adr-frontmatter.ts test/adr-frontmatter.spec.ts
git commit -m "feat: add ADR frontmatter parser"
```

---
### Task 3: ADR Markdown Chunker

**Files:**
- Create: `src/plugins/dsh-context-milvus/adr-chunker.ts`
- Create: `test/adr-chunker.spec.ts`

**Interfaces:**
- Consumes: `AdrChunk`, `AdrFrontmatter` types, `parseFrontmatter()`
- Produces: `chunkAdrFile(filePath: string, content: string): Promise<AdrChunk[]>`

- [ ] **Step 1: Write the failing test**

```typescript
// test/adr-chunker.spec.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/adr-chunker.spec.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `adr-chunker.ts`**

```typescript
// src/plugins/dsh-context-milvus/adr-chunker.ts
import { parseFrontmatter } from './adr-frontmatter.js'
import type { AdrChunk } from './types.js'

/** Section heading → section label mapping */
const SECTION_MAP: Record<string, string> = {
  '决策目标': 'goal',
  '约束条件': 'constraints',
  '候选方案与权衡': 'alternatives',
  '关键设计细节与隐性约束': 'hidden_constraints',
  '被否决的模式/反模式': 'rejected',
  '相关测试': 'tests',
  '变更边界': 'boundary',
}

const SECTION_HEADING_RE = /^## (.+)$/m

/**
 * Split an ADR markdown file into section chunks.
 * Each ## heading becomes a separate chunk.
 * The frontmatter is parsed for metadata; sections without ## headings
 * are not chunked.
 */
export async function chunkAdrFile(filePath: string, content: string): Promise<AdrChunk[]> {
  const frontmatter = parseFrontmatter(content)
  if (!frontmatter) return []

  // Remove frontmatter line for section splitting
  const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
  if (!body) return []

  const lines = body.split('\n')
  const chunks: AdrChunk[] = []
  let currentSection = ''
  let currentLines: string[] = []
  let currentStartLine = 0
  // Count frontmatter lines for offset
  const fmMatch = content.match(/^---[\s\S]*?---\n?/)
  const fmLineCount = fmMatch ? fmMatch[0].split('\n').length : 0
  let lineOffset = fmLineCount

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const headingMatch = line.match(/^## (.+)/)

    if (headingMatch) {
      // Flush previous section
      if (currentSection && currentLines.length > 0) {
        const sectionLabel = SECTION_MAP[currentSection] || currentSection
        chunks.push({
          filePath,
          adrId: frontmatter.id,
          section: sectionLabel,
          content: currentLines.join('\n').trim(),
          startLine: currentStartLine + lineOffset,
          endLine: i + lineOffset - 1,
          status: frontmatter.status,
          codeAnchors: frontmatter.code_anchors.map(a => a.file),
          triggerType: frontmatter.trigger.change_type,
        })
      }
      currentSection = headingMatch[1].trim()
      currentLines = []
      currentStartLine = i + 1
    } else {
      currentLines.push(line)
    }
  }

  // Flush last section
  if (currentSection && currentLines.length > 0) {
    const sectionLabel = SECTION_MAP[currentSection] || currentSection
    chunks.push({
      filePath,
      adrId: frontmatter.id,
      section: sectionLabel,
      content: currentLines.join('\n').trim(),
      startLine: currentStartLine + lineOffset,
      endLine: lines.length + lineOffset,
      status: frontmatter.status,
      codeAnchors: frontmatter.code_anchors.map(a => a.file),
      triggerType: frontmatter.trigger.change_type,
    })
  }

  return chunks
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/adr-chunker.spec.ts -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/adr-chunker.ts test/adr-chunker.spec.ts
git commit -m "feat: add ADR markdown section chunker"
```

---
### Task 4: code_anchors Reverse Index

**Files:**
- Create: `src/plugins/dsh-context-milvus/adr-anchor-index.ts`
- Create: `test/adr-anchor-index.spec.ts`

**Interfaces:**
- Consumes: `AnchorIndexStats` type
- Produces: `AdrAnchorIndex` class

- [ ] **Step 1: Write the failing test**

```typescript
// test/adr-anchor-index.spec.ts
import { jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const { AdrAnchorIndex } = await import('../src/plugins/dsh-context-milvus/adr-anchor-index.js')

describe('AdrAnchorIndex', () => {
  let tempDir: string
  let index: AdrAnchorIndex

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'anchor-test-'))
    index = new AdrAnchorIndex(path.join(tempDir, 'anchors.json'))
  })

  it('starts empty', async () => {
    await index.load()
    expect(index.getAdrsForFile('src/test.ts')).toEqual([])
    expect(index.getStats().adrCount).toBe(0)
  })

  it('stores and retrieves file-to-ADR mapping', () => {
    index.setAdr('ADR-0001', ['src/a.ts', 'src/b.ts'])
    index.setAdr('ADR-0002', ['src/b.ts', 'src/c.ts'])
    expect(index.getAdrsForFile('src/a.ts')).toEqual(['ADR-0001'])
    expect(index.getAdrsForFile('src/b.ts')).toEqual(['ADR-0001', 'ADR-0002'])
    expect(index.getAdrsForFile('src/c.ts')).toEqual(['ADR-0002'])
    expect(index.getAdrsForFile('src/unknown.ts')).toEqual([])
  })

  it('returns files for a given ADR', () => {
    index.setAdr('ADR-0001', ['src/a.ts', 'src/b.ts'])
    expect(index.getFilesForAdr('ADR-0001')).toEqual(['src/a.ts', 'src/b.ts'])
    expect(index.getFilesForAdr('ADR-unknown')).toEqual([])
  })

  it('removes ADR and its anchor mappings', () => {
    index.setAdr('ADR-0001', ['src/a.ts'])
    index.setAdr('ADR-0002', ['src/a.ts'])
    index.removeAdr('ADR-0001')
    expect(index.getAdrsForFile('src/a.ts')).toEqual(['ADR-0002'])
    expect(index.getStats().adrCount).toBe(1)
  })

  it('persists and reloads', async () => {
    index.setAdr('ADR-0001', ['src/a.ts'])
    await index.save()

    const index2 = new AdrAnchorIndex(path.join(tempDir, 'anchors.json'))
    await index2.load()
    expect(index2.getAdrsForFile('src/a.ts')).toEqual(['ADR-0001'])
    expect(index2.getStats().adrCount).toBe(1)
  })

  it('provides stats', () => {
    index.setAdr('ADR-0001', ['src/a.ts', 'src/b.ts'])
    index.setAdr('ADR-0002', ['src/c.ts'])
    const stats = index.getStats()
    expect(stats.adrCount).toBe(2)
    expect(stats.anchorCount).toBe(3)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/adr-anchor-index.spec.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `adr-anchor-index.ts`**

```typescript
// src/plugins/dsh-context-milvus/adr-anchor-index.ts
import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import type { AnchorIndexStats } from './types.js'

/** Reverse index: file path → ADR ids, persisted as JSON sidecar */
export class AdrAnchorIndex {
  /** filePath → ADR ids */
  private fileToAdrs = new Map<string, string[]>()
  /** adrId → file paths */
  private adrToFiles = new Map<string, string[]>()
  private dirty = false

  constructor(private readonly filePath: string) {}

  /** Load index from disk */
  async load(): Promise<boolean> {
    if (!existsSync(this.filePath)) return false
    try {
      const data = JSON.parse(await readFile(this.filePath, 'utf-8'))
      this.fileToAdrs = new Map(Object.entries(data.fileToAdrs ?? {}))
      this.adrToFiles = new Map(Object.entries(data.adrToFiles ?? {}))
      this.dirty = false
      return true
    } catch {
      return false
    }
  }

  /** Save index to disk */
  async save(): Promise<void> {
    if (!this.dirty) return
    const data = {
      fileToAdrs: Object.fromEntries(this.fileToAdrs),
      adrToFiles: Object.fromEntries(this.adrToFiles),
    }
    await writeFile(this.filePath, JSON.stringify(data, null, 2), 'utf-8')
    this.dirty = false
  }

  /** Get all ADR ids that anchor a given file */
  getAdrsForFile(filePath: string): string[] {
    // Normalize: remove leading ./ and resolve relative paths
    const normalized = normalizePath(filePath)
    // Try exact, then try each key with normalized comparison
    for (const [key, adrs] of this.fileToAdrs) {
      if (filePath.endsWith(key) || key.endsWith(filePath) || normalized === normalizePath(key)) {
        return [...adrs]
      }
    }
    const direct = this.fileToAdrs.get(filePath)
    return direct ? [...direct] : []
  }

  /** Get all file paths anchored by a given ADR */
  getFilesForAdr(adrId: string): string[] {
    return [...(this.adrToFiles.get(adrId) ?? [])]
  }

  /** Set/update anchor mappings for one ADR */
  setAdr(adrId: string, files: string[]): void {
    // Remove old mappings for this ADR
    this.removeAdr(adrId)

    // Set new mappings
    this.adrToFiles.set(adrId, [...files])
    for (const file of files) {
      const existing = this.fileToAdrs.get(file) ?? []
      existing.push(adrId)
      this.fileToAdrs.set(file, existing)
    }
    this.dirty = true
  }

  /** Remove all anchor mappings for one ADR */
  removeAdr(adrId: string): void {
    const oldFiles = this.adrToFiles.get(adrId)
    if (oldFiles) {
      for (const file of oldFiles) {
        const adrs = this.fileToAdrs.get(file)
        if (adrs) {
          const filtered = adrs.filter(id => id !== adrId)
          if (filtered.length > 0) {
            this.fileToAdrs.set(file, filtered)
          } else {
            this.fileToAdrs.delete(file)
          }
        }
      }
    }
    this.adrToFiles.delete(adrId)
    this.dirty = true
  }

  /** Get all file → ADR mappings */
  getAll(): Map<string, string[]> {
    return new Map(this.fileToAdrs)
  }

  /** Get index statistics */
  getStats(): AnchorIndexStats {
    let anchorCount = 0
    for (const files of this.adrToFiles.values()) {
      anchorCount += files.length
    }
    return {
      adrCount: this.adrToFiles.size,
      anchorCount,
    }
  }
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, '').replace(/\\/g, '/')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/adr-anchor-index.spec.ts -v`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/adr-anchor-index.ts test/adr-anchor-index.spec.ts
git commit -m "feat: add code_anchors reverse index"
```

---
### Task 5: MilvusService ADR Collection Extension

**Files:**
- Modify: `src/plugins/dsh-context-milvus/milvus-service.ts`
- Modify: `test/dsh-context-remdb.spec.ts` (add ADR collection tests)

**Interfaces:**
- Consumes: existing `MilvusService`, `AdrChunk`, `AdrSearchResult` types
- Produces: `ensureAdrCollection()`, `insertAdrChunks()`, `searchAdr()`, `deleteAdrByFilePath()`

- [ ] **Step 1: Write the failing test**

Add to `test/dsh-context-remdb.spec.ts` (after existing MilvusService describe block):

```typescript
describe('MilvusService ADR collection', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockHasCollection.mockResolvedValue({ value: false })
    mockCreateCollection.mockResolvedValue({})
    mockCreateIndex.mockResolvedValue({})
    mockLoadCollectionSync.mockResolvedValue({})
  })

  it('ensures ADR collection with correct schema', async () => {
    const embedding = mockEmbeddingClient()
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    // Set adrCollection
    ;(service as any).adrCollection = 'adr_embeddings'

    await service.ensureAdrCollection()

    expect(mockCreateCollection).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_name: 'adr_embeddings',
      }),
    )
    // Verify ADR-specific fields exist
    const callArgs = mockCreateCollection.mock.calls[0][0]
    const fieldNames = callArgs.fields.map((f: any) => f.name)
    expect(fieldNames).toContain('adr_id')
    expect(fieldNames).toContain('status')
    expect(fieldNames).toContain('section')
    expect(fieldNames).toContain('code_anchors')
    expect(fieldNames).toContain('trigger_type')
  })

  it('inserts ADR chunks with vectors', async () => {
    mockInsert.mockResolvedValue({ insert_cnt: 2 })
    const embedding = mockEmbeddingClient([[0.1, 0.2], [0.3, 0.4]])
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    ;(service as any).adrCollection = 'adr_embeddings'

    const chunks = [
      { filePath: '/doc.md', adrId: 'ADR-0001', section: 'goal', content: 'text', startLine: 1, endLine: 2, status: 'active', codeAnchors: ['src/a.ts'], triggerType: 'refactor', vector: [0.1, 0.2] },
      { filePath: '/doc.md', adrId: 'ADR-0001', section: 'constraints', content: 'text2', startLine: 3, endLine: 4, status: 'active', codeAnchors: ['src/a.ts'], triggerType: 'refactor', vector: [0.3, 0.4] },
    ]
    const count = await service.insertAdrChunks(chunks as any)
    expect(count).toBe(2)
    expect(mockInsert).toHaveBeenCalledWith(
      expect.objectContaining({ collection_name: 'adr_embeddings' }),
    )
  })

  it('searches ADR collection', async () => {
    const embedding = mockEmbeddingClient([[0.1, 0.2, 0.3]])
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    ;(service as any).adrCollection = 'adr_embeddings'

    mockSearch.mockResolvedValue({
      results: [{
        adr_id: 'ADR-0001',
        file_path: '/doc.md',
        status: 'active',
        section: 'goal',
        code_content: 'text',
        score: 0.95,
        trigger_type: 'refactor',
        code_anchors: '["src/a.ts"]',
      }],
    })

    const results = await service.searchAdr('test query', 5)
    expect(results).toHaveLength(1)
    expect(results[0].adrId).toBe('ADR-0001')
    expect(results[0].score).toBe(0.95)
  })

  it('deletes ADR chunks by file path', async () => {
    mockDelete.mockResolvedValue({ delete_cnt: 3 })
    const embedding = mockEmbeddingClient()
    const service = new MilvusService({
      address: 'localhost:19530',
      collection: 'code_embeddings',
      dim: 768,
      embeddingClient: embedding,
      hybridMode: false,
    })
    ;(service as any).adrCollection = 'adr_embeddings'

    const count = await service.deleteAdrByFilePath('/doc.md')
    expect(count).toBe(3)
    expect(mockDelete).toHaveBeenCalledWith(
      expect.objectContaining({
        collection_name: 'adr_embeddings',
        filter: 'file_path == "/doc.md"',
      }),
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/dsh-context-remdb.spec.ts -t "ADR collection" -v`
Expected: Methods don't exist yet, tests fail

- [ ] **Step 3: Implement MilvusService ADR methods**

In `src/plugins/dsh-context-milvus/milvus-service.ts`:

Add `adrCollection` field to constructor config:
```typescript
interface MilvusServiceConfig {
  address: string
  token?: string
  collection: string
  dim: number
  embeddingClient: EmbeddingClient
  hybridMode?: boolean
  bm25RrfK?: number
  adrCollection?: string  // NEW
}
```

Add to constructor:
```typescript
this.adrCollection = config.adrCollection ?? 'adr_embeddings'
this.adrCollectionReady = false
this.adrInitPromise = null
```

Add `ensureAdrCollection()` method (same pattern as `initCollection` but with ADR schema):

```typescript
async ensureAdrCollection(): Promise<void> {
  if (this.adrCollectionReady) return
  if (this.adrInitPromise) return this.adrInitPromise
  this.adrInitPromise = this.initAdrCollection()
  try {
    await this.adrInitPromise
    this.adrCollectionReady = true
  } finally {
    this.adrInitPromise = null
  }
}

private async initAdrCollection(): Promise<void> {
  const client = this.getClient()
  const adrCollection = this.adrCollection

  await client.connectPromise

  const hasRes = await client.hasCollection({ collection_name: adrCollection })
  if (hasRes.value) {
    this.adrCollectionReady = true
    return
  }

  await client.createCollection({
    collection_name: adrCollection,
    fields: [
      { name: 'id', data_type: DataType.Int64, is_primary_key: true, autoID: true },
      { name: 'vector', data_type: DataType.FloatVector, dim: this.dim },
      ...(this.hybridMode ? [{ name: 'sparse_vector', data_type: DataType.SparseFloatVector }] : []),
      { name: 'adr_id', data_type: DataType.VarChar, max_length: 256 },
      { name: 'file_path', data_type: DataType.VarChar, max_length: 1024 },
      { name: 'status', data_type: DataType.VarChar, max_length: 32 },
      { name: 'section', data_type: DataType.VarChar, max_length: 64 },
      { name: 'content', data_type: DataType.VarChar, max_length: 65535, ...(this.hybridMode ? { type_params: { enable_analyzer: 'true' } } : {}) },
      { name: 'start_line', data_type: DataType.Int32 },
      { name: 'end_line', data_type: DataType.Int32 },
      { name: 'code_anchors', data_type: DataType.VarChar, max_length: 1024 },
      { name: 'trigger_type', data_type: DataType.VarChar, max_length: 64 },
    ],
    enable_dynamic_field: true,
    ...(this.hybridMode ? {
      functions: [{
        name: 'bm25_fn', type: FunctionType.BM25,
        input_field_names: ['content'], output_field_names: ['sparse_vector'], params: {},
      }],
    } : {}),
  } as any)

  await client.createIndex({
    collection_name: adrCollection, field_name: 'vector',
    metric_type: MetricType.COSINE, index_name: 'idx_vector',
  } as any)
  if (this.hybridMode) {
    await client.createIndex({
      collection_name: adrCollection, field_name: 'sparse_vector',
      index_type: 'SPARSE_INVERTED_INDEX', metric_type: MetricType.BM25, index_name: 'idx_sparse_bm25',
    } as any)
  }
  await client.loadCollectionSync({ collection_name: adrCollection })
}
```

Add `insertAdrChunks()`:
```typescript
async insertAdrChunks(chunks: Array<AdrChunk & { vector: number[] }>): Promise<number> {
  if (chunks.length === 0) return 0
  const client = this.getClient()
  let totalInserted = 0
  const batchSize = 100
  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize)
    const response = await client.insert({
      collection_name: this.adrCollection,
      data: batch.map(chunk => ({
        vector: chunk.vector,
        adr_id: chunk.adrId,
        file_path: chunk.filePath,
        status: chunk.status,
        section: chunk.section,
        content: chunk.content,
        start_line: chunk.startLine,
        end_line: chunk.endLine,
        code_anchors: JSON.stringify(chunk.codeAnchors),
        trigger_type: chunk.triggerType,
      })),
    })
    totalInserted += Number(response.insert_cnt ?? 0)
  }
  return totalInserted
}
```

Add `searchAdr()`:
```typescript
async searchAdr(query: string, topK: number, filters?: { status?: string; pathPrefix?: string }): Promise<AdrSearchResult[]> {
  const client = this.getClient()
  const vectors = await this.embeddingClient.embed([query])
  if (vectors.length === 0) return []
  const vector = vectors[0]

  const outputFields = ['adr_id', 'file_path', 'status', 'section', 'content', 'start_line', 'end_line', 'code_anchors', 'trigger_type']

  // Build filter expression
  let filterExpr = ''
  if (filters?.status && filters.status !== 'all') {
    filterExpr = `status == "${filters.status}"`
  }
  if (filters?.pathPrefix) {
    const pathFilter = `file_path like "${filters.pathPrefix}%"`
    filterExpr = filterExpr ? `${filterExpr} and ${pathFilter}` : pathFilter
  }

  let response: any
  if (this.effectiveHybridMode) {
    response = await client.hybridSearch({
      collection_name: this.adrCollection,
      data: [
        { anns_field: 'vector', data: vector, params: { metric_type: 'COSINE' } },
        { anns_field: 'sparse_vector', data: query, params: { metric_type: 'BM25' } },
      ],
      rerank: { strategy: RANKER_TYPE.RRF, params: { k: this.bm25RrfK } },
      limit: topK,
      output_fields: outputFields,
      ...(filterExpr ? { filter: filterExpr } : {}),
    } as any)
  } else {
    const searchParams: any = {
      collection_name: this.adrCollection,
      vector,
      limit: topK,
      output_fields: outputFields,
    }
    if (filterExpr) searchParams.filter = filterExpr
    response = await client.search(searchParams)
  }

  const raw = (response.results ?? []) as unknown
  const items = Array.isArray(raw) && raw.length > 0 && Array.isArray((raw as any[])[0])
    ? (raw as any[][]).flat() : (raw as any[])

  return items.map((item: any) => ({
    adrId: item.adr_id ?? '',
    filePath: item.file_path ?? '',
    status: item.status ?? '',
    section: item.section ?? '',
    content: item.content ?? '',
    score: item.score,
    triggerType: item.trigger_type ?? '',
    codeAnchors: (() => { try { return JSON.parse(item.code_anchors ?? '[]') } catch { return [] } })(),
  }))
}
```

Add `deleteAdrByFilePath()`:
```typescript
async deleteAdrByFilePath(filePath: string): Promise<number> {
  const client = this.getClient()
  const response = await client.delete({
    collection_name: this.adrCollection,
    filter: `file_path == "${filePath}"`,
  })
  return Number(response.delete_cnt ?? 0)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/dsh-context-remdb.spec.ts -t "ADR collection" -v`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/milvus-service.ts test/dsh-context-remdb.spec.ts
git commit -m "feat: extend MilvusService with ADR collection support"
```

---
### Task 6: ADR Service (CRUD + State Management)

**Files:**
- Create: `src/plugins/dsh-context-milvus/adr-service.ts`
- Create: `test/adr-service.spec.ts`

**Interfaces:**
- Consumes: `AdrFrontmatter`, `AdrDocument`, `AdrListItem`, `ConstraintSummary`, `CreateAdrParams`, `UpdateAdrParams`, `AdrFilter`, `parseFrontmatter()`, `AdrAnchorIndex`
- Produces: `AdrService` class with `createAdr()`, `updateAdr()`, `listAdrs()`, `loadAdr()`, `findMaxSerial()`, `getActiveConstraints()`, `getAllAdrFiles()`

- [ ] **Step 1: Write the failing test**

```typescript
// test/adr-service.spec.ts
import { jest } from '@jest/globals'
import { mkdtemp, writeFile, readFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

const { AdrService } = await import('../src/plugins/dsh-context-milvus/adr-service.js')

describe('AdrService', () => {
  let tempDir: string
  let adrDir: string
  let service: AdrService

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'adr-svc-'))
    adrDir = path.join(tempDir, 'docs', 'decisions')
    await mkdir(adrDir, { recursive: true })
    service = new AdrService(adrDir)
  })

  it('finds max serial number with no existing ADRs', async () => {
    const serial = await service.findMaxSerial()
    expect(serial).toBe(0)
  })

  it('finds max serial number with existing ADRs', async () => {
    await writeFile(path.join(adrDir, 'ADR-0001-first.md'), '---\nid: ADR-0001-first\n---\nBody')
    await writeFile(path.join(adrDir, 'ADR-0003-third.md'), '---\nid: ADR-0003-third\n---\nBody')
    const serial = await service.findMaxSerial()
    expect(serial).toBe(3)
  })

  it('creates an ADR file with auto-numbering', async () => {
    const result = await service.createAdr({
      title: 'test-decision',
      requirement: 'Test requirement',
      changeType: 'refactor',
    })
    expect(result.id).toBe('ADR-0001-test-decision')
    expect(result.filePath).toContain('ADR-0001-test-decision.md')

    // Verify file exists and has frontmatter
    const content = await readFile(result.filePath, 'utf-8')
    expect(content).toContain('id: ADR-0001-test-decision')
    expect(content).toContain('change_type: refactor')
    expect(content).toContain('requirement_summary: "Test requirement"')
  })

  it('increments ADR serial numbers', async () => {
    await service.createAdr({ title: 'first' })
    const result = await service.createAdr({ title: 'second' })
    expect(result.id).toBe('ADR-0002-second')
  })

  it('lists ADRs with correct info', async () => {
    await service.createAdr({ title: 'first', changeType: 'refactor' })
    await service.createAdr({ title: 'second', changeType: 'new_feature' })
    const list = await service.listAdrs({ status: 'active' })
    expect(list).toHaveLength(2)
    expect(list[0].id).toBe('ADR-0001-first')
    expect(list[1].id).toBe('ADR-0002-second')
  })

  it('filters ADRs by status', async () => {
    await service.createAdr({ title: 'active-one' })
    await service.createAdr({ title: 'active-two' })
    const list = await service.listAdrs({ status: 'deprecated' })
    expect(list).toHaveLength(0)
  })

  it('loads an ADR document', async () => {
    await service.createAdr({ title: 'test' })
    const doc = await service.loadAdr('ADR-0001-test')
    expect(doc).not.toBeNull()
    expect(doc!.frontmatter.id).toBe('ADR-0001-test')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/adr-service.spec.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `adr-service.ts`**

```typescript
// src/plugins/dsh-context-milvus/adr-service.ts
import { readFile, writeFile, readdir, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { parseFrontmatter } from './adr-frontmatter.js'
import type {
  AdrFrontmatter, AdrDocument, AdrListItem, ConstraintSummary,
  CreateAdrParams, UpdateAdrParams, AdrFilter,
} from './types.js'

const ADR_FILENAME_RE = /^ADR-(\d{4})-(.+)\.md$/
const DEFAULT_TEMPLATE = `---
id: ADR-{serial}-{title}
type: decision-record
status: active
created: {created}
updated: {created}
author: dsh-context-milvus
supersedes: {supersedes}
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "{requirement}"
  change_type: {change_type}
related_decisions: []
auto_generated: false
---

## 决策目标

{description}

## 约束条件

{constraints}

## 候选方案与权衡

### 方案A：{方案名称}
- **描述**：{方案简要说明}
- **优点**：{列出优点}
- **缺点**：{列出缺点}
- **放弃原因**：{明确说明为什么不用这个方案}

### 方案B：{方案名称}（✅ 选用）
- **描述**：{方案简要说明}
- **优点**：{列出优点}
- **缺点**：{列出缺点}
- **选择原因**：{说明为什么这是最优解}

## 关键设计细节与隐性约束

### 隐性约束1：{约束名称}
- **内容**：{具体约束是什么}
- **原因**：{为什么有这个约束}
- **如果破坏会怎样**：{破坏后的具体后果}

## 被否决的模式/反模式

- ❌ {反模式} —— {为什么禁止}

## 相关测试

- {测试文件路径}: {测试覆盖的约束}

## 变更边界

- {条件触发时，重新评估此决策}
`

export class AdrService {
  constructor(private adrRoot: string) {
    if (!existsSync(adrRoot)) {
      mkdirSync(adrRoot, { recursive: true })
    }
  }

  /** Find the maximum ADR serial number in the directory */
  async findMaxSerial(): Promise<number> {
    let maxSerial = 0
    try {
      const files = await readdir(this.adrRoot)
      for (const file of files) {
        const match = ADR_FILENAME_RE.exec(file)
        if (match) {
          const serial = parseInt(match[1], 10)
          if (serial > maxSerial) maxSerial = serial
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    return maxSerial
  }

  /** Create a new ADR file */
  async createAdr(params: CreateAdrParams): Promise<{ id: string; filePath: string }> {
    const serial = await this.findMaxSerial() + 1
    const serialStr = String(serial).padStart(4, '0')
    const title = params.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
    const adrId = `ADR-${serialStr}-${title}`
    const fileName = `${adrId}.md`
    const filePath = path.join(this.adrRoot, fileName)
    const now = new Date().toISOString()

    const content = params.content || DEFAULT_TEMPLATE
      .replace(/{serial}/g, serialStr)
      .replace(/{title}/g, title)
      .replace(/{created}/g, now)
      .replace(/{requirement}/g, params.requirement ?? '')
      .replace(/{change_type}/g, params.changeType ?? 'new_feature')
      .replace(/{supersedes}/g, params.supersedes ?? 'null')
      .replace(/{description}/g, `New ADR: ${params.title}`)
      .replace(/{constraints}/g, '')

    await writeFile(filePath, content, 'utf-8')
    return { id: adrId, filePath }
  }

  /** Update an existing ADR file */
  async updateAdr(adrId: string, params: UpdateAdrParams): Promise<{ id: string; filePath: string }> {
    const filePath = await this.findAdrFile(adrId)
    if (!filePath) throw new Error(`ADR not found: ${adrId}`)

    let content = await readFile(filePath, 'utf-8')

    if (params.content) {
      if (params.merge) {
        // Replace body only, keep frontmatter
        const fmEnd = content.indexOf('---', 3) + 3
        content = content.slice(0, fmEnd) + '\n' + params.content
      } else {
        content = params.content
      }
    }

    // Update status in frontmatter if requested
    if (params.status) {
      content = content.replace(
        /^status: .+/m,
        `status: ${params.status}`,
      )
    }
    if (params.supersededBy) {
      content = content.replace(
        /^superseded_by: .+/m,
        `superseded_by: ${params.supersededBy}`,
      )
    }

    // Update timestamp
    const now = new Date().toISOString()
    content = content.replace(
      /^updated: .+/m,
      `updated: ${now}`,
    )

    await writeFile(filePath, content, 'utf-8')
    return { id: adrId, filePath }
  }

  /** List ADR files with optional filters */
  async listAdrs(filter?: AdrFilter): Promise<AdrListItem[]> {
    const files = await this.getAllAdrFiles()
    const items: AdrListItem[] = []

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      if (!fm) continue

      // Apply status filter
      if (filter?.status && filter.status !== 'all' && fm.status !== filter.status) continue
      // Apply changeType filter
      if (filter?.changeType && fm.trigger.change_type !== filter.changeType) continue

      // Extract summary from first section
      const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
      const summary = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 100) || ''

      items.push({
        id: fm.id,
        filePath,
        status: fm.status,
        created: fm.created,
        updated: fm.updated,
        anchorCount: fm.code_anchors.length,
        summary,
        changeType: fm.trigger.change_type,
      })

      if (filter?.limit && items.length >= filter.limit) break
    }

    return items
  }

  /** Load a full ADR document */
  async loadAdr(adrId: string): Promise<AdrDocument | null> {
    const filePath = await this.findAdrFile(adrId)
    if (!filePath) return null

    const content = await readFile(filePath, 'utf-8')
    const fm = parseFrontmatter(content)
    if (!fm) return null

    // Parse sections
    const sections: Record<string, string> = {}
    const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
    let currentSection = 'body'
    let currentLines: string[] = []
    for (const line of body.split('\n')) {
      const headingMatch = line.match(/^## (.+)/)
      if (headingMatch) {
        if (currentLines.length > 0) {
          sections[currentSection] = currentLines.join('\n').trim()
        }
        currentSection = headingMatch[1].trim()
        currentLines = []
      } else {
        currentLines.push(line)
      }
    }
    if (currentLines.length > 0) {
      sections[currentSection] = currentLines.join('\n').trim()
    }

    return { frontmatter: fm, sections, rawContent: content, filePath }
  }

  /** Get all active ADR constraints */
  async getActiveConstraints(): Promise<ConstraintSummary[]> {
    const files = await this.getAllAdrFiles()
    const summaries: ConstraintSummary[] = []

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      if (!fm || fm.status !== 'active') continue

      // Parse body for constraints sections
      const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
      const sections = body.split('\n## ')
      let constraints: string[] = []
      let hiddenConstraints: Array<{ name: string; content: string; consequence: string }> = []
      let rejectedPatterns: string[] = []

      for (const section of sections) {
        if (section.startsWith('约束条件')) {
          constraints = section.split('\n')
            .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
            .map(l => l.replace(/^[-*]\s*/, '').replace(/\(来源:.*?\)/, '').trim())
            .filter(Boolean)
        }
        if (section.startsWith('关键设计细节与隐性约束')) {
          // Parse hidden constraint blocks
          const blocks = section.split('### ')
          for (const block of blocks.slice(1)) {
            const lines = block.split('\n')
            const name = lines[0]?.trim() || ''
            const content = lines.find(l => l.includes('**内容**'))?.replace(/.*\*\*内容\*\*:\s*/, '').trim() || ''
            const consequence = lines.find(l => l.includes('**如果破坏会怎样**'))?.replace(/.*\*\*如果破坏会怎样\*\*:\s*/, '').trim() || ''
            if (name) {
              hiddenConstraints.push({ name, content, consequence })
            }
          }
        }
        if (section.startsWith('被否决的模式/反模式')) {
          rejectedPatterns = section.split('\n')
            .filter(l => l.trim().startsWith('❌'))
            .map(l => l.replace(/^❌\s*/, '').trim())
            .filter(Boolean)
        }
      }

      if (constraints.length > 0 || hiddenConstraints.length > 0 || rejectedPatterns.length > 0) {
        const title = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 80) || fm.id
        summaries.push({
          adrId: fm.id,
          adrTitle: title,
          constraints,
          hiddenConstraints,
          rejectedPatterns,
          status: fm.status,
        })
      }
    }

    return summaries
  }

  /** Get all ADR file paths */
  async getAllAdrFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.adrRoot)
      return files
        .filter(f => ADR_FILENAME_RE.test(f))
        .map(f => path.join(this.adrRoot, f))
        .sort()
    } catch {
      return []
    }
  }

  /** Find an ADR file by id (partial or full match) */
  private async findAdrFile(adrId: string): Promise<string | null> {
    const files = await this.getAllAdrFiles()
    // Exact match first
    const exact = files.find(f => path.basename(f).startsWith(adrId))
    if (exact) return exact
    // Partial match (serial number)
    return files.find(f => path.basename(f).includes(adrId)) ?? null
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/adr-service.spec.ts -v`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/adr-service.ts test/adr-service.spec.ts
git commit -m "feat: add ADR CRUD service"
```

---
### Task 7: ADR Indexer

**Files:**
- Create: `src/plugins/dsh-context-milvus/adr-indexer.ts`
- Create: `test/adr-indexer.spec.ts`

**Interfaces:**
- Consumes: `MilvusService`, `PluginConfig`, `HashTracker`, `AdrAnchorIndex`, `chunkAdrFile()`, `EmbeddingClient`
- Produces: `runAdrIndex()`, `getAdrIndexStatus()`

- [ ] **Step 1: Write the failing test**

```typescript
// test/adr-indexer.spec.ts
import { jest } from '@jest/globals'
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises'
import * as path from 'node:path'
import { tmpdir } from 'node:os'

// Mock Milvus SDK
const mockInsert = jest.fn()
const mockDelete = jest.fn()
const mockHasCollection = jest.fn()
const mockCreateCollection = jest.fn()
const mockCreateIndex = jest.fn()
const mockLoadCollectionSync = jest.fn()
const mockConnectPromise = Promise.resolve()

jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({
    connectPromise: mockConnectPromise,
    hasCollection: mockHasCollection,
    createCollection: mockCreateCollection,
    createIndex: mockCreateIndex,
    loadCollectionSync: mockLoadCollectionSync,
    insert: mockInsert,
    delete: mockDelete,
  })),
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { MilvusService } = await import('../src/plugins/dsh-context-milvus/milvus-service.js')
const { HashTracker } = await import('../src/plugins/dsh-context-milvus/merkle.js')
const { AdrAnchorIndex } = await import('../src/plugins/dsh-context-milvus/adr-anchor-index.js')
const { runAdrIndex, getAdrIndexStatus } = await import('../src/plugins/dsh-context-milvus/adr-indexer.js')

describe('runAdrIndex', () => {
  let tempDir: string
  let adrDir: string
  let config: any
  let milvus: any
  let tracker: HashTracker
  let anchorIndex: AdrAnchorIndex

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(tmpdir(), 'adr-idx-'))
    adrDir = path.join(tempDir, 'docs', 'decisions')
    await mkdir(adrDir, { recursive: true })

    config = {
      indexRoot: tempDir,
      adrRoot: adrDir,
      adrEnabled: true,
      embedding: { endpoint: 'http://test/embed', model: 'test', dim: 3, apiKey: undefined },
      ignorePatterns: [],
    }

    mockHasCollection.mockResolvedValue({ value: false })
    mockCreateCollection.mockResolvedValue({})
    mockCreateIndex.mockResolvedValue({})
    mockLoadCollectionSync.mockResolvedValue({})
    mockInsert.mockResolvedValue({ insert_cnt: 1 })
    mockDelete.mockResolvedValue({ delete_cnt: 0 })

    const embeddingMock = { embed: jest.fn().mockResolvedValue([[0.1, 0.2, 0.3]]) }
    milvus = new MilvusService({
      address: 'localhost:19530', collection: 'test', dim: 3,
      embeddingClient: embeddingMock, hybridMode: false,
    })
    milvus.ensureCollection = jest.fn().mockResolvedValue(undefined)
    milvus.ensureAdrCollection = jest.fn().mockResolvedValue(undefined)
    milvus.insertAdrChunks = jest.fn().mockResolvedValue(1)
    milvus.deleteAdrByFilePath = jest.fn().mockResolvedValue(0)

    const merklePath = path.join(tempDir, 'adr-merkle.json')
    tracker = new HashTracker(merklePath)
    await tracker.load()

    const anchorPath = path.join(tempDir, 'anchors.json')
    anchorIndex = new AdrAnchorIndex(anchorPath)
    await anchorIndex.load()
  })

  it('indexes ADR files and returns counts', async () => {
    // Create a sample ADR
    await writeFile(path.join(adrDir, 'ADR-0001-test.md'),
      `---
id: ADR-0001-test
type: decision-record
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test"
  change_type: refactor
related_decisions: []
auto_generated: false
---

## 决策目标

Test goal
`)

    const result = await runAdrIndex(config, milvus, tracker, anchorIndex)
    expect(result.filesIndexed).toBe(1)
    expect(result.chunksIndexed).toBeGreaterThanOrEqual(1)
    expect(milvus.ensureAdrCollection).toHaveBeenCalled()
    expect(milvus.insertAdrChunks).toHaveBeenCalled()
  })

  it('skips unchanged files in incremental mode', async () => {
    // Index once
    await writeFile(path.join(adrDir, 'ADR-0001-test.md'),
      `---
id: ADR-0001-test
type: decision-record
status: active
created: 2026-09-01T00:00:00Z
updated: 2026-09-01T00:00:00Z
author: test
supersedes: null
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "Test"
  change_type: refactor
related_decisions: []
auto_generated: false
---

## 决策目标

Test
`)
    await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'full' })
    jest.clearAllMocks()

    // Second run (incremental) — no changes
    const result = await runAdrIndex(config, milvus, tracker, anchorIndex, { mode: 'incremental' })
    expect(result.filesIndexed).toBe(0)
    expect(result.filesSkipped).toBe(1)
  })

  it('returns index status', async () => {
    const { AdrService } = await import('../src/plugins/dsh-context-milvus/adr-service.js')
    const status = await getAdrIndexStatus(tracker, new AdrService(adrDir))
    expect(status).toHaveProperty('totalAdrs')
    expect(status).toHaveProperty('totalChunks')
    expect(status).toHaveProperty('lastIndexed')
    expect(status).toHaveProperty('activeAdrs')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/adr-indexer.spec.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `adr-indexer.ts`**

```typescript
// src/plugins/dsh-context-milvus/adr-indexer.ts
import { readFile, readdir } from 'node:fs/promises'
import * as path from 'node:path'
import { HashTracker } from './merkle.js'
import { EmbeddingClient } from './embedding.js'
import { chunkAdrFile } from './adr-chunker.js'
import { AdrAnchorIndex } from './adr-anchor-index.js'
import type { MilvusService } from './milvus-service.js'
import type { PluginConfig, AdrIndexStatus, AdrChunk } from './types.js'
import type { AdrService } from './adr-service.js'

const ADR_FILE_RE = /^ADR-\d{4}-.+\.md$/

export interface AdrIndexResult {
  filesIndexed: number
  chunksIndexed: number
  filesRemoved: number
  chunksRemoved: number
  filesSkipped: number
  durationMs: number
}

export async function runAdrIndex(
  config: PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  anchorIndex: AdrAnchorIndex,
  options?: { mode?: 'full' | 'incremental'; progress?: (msg: string) => void },
): Promise<AdrIndexResult> {
  const mode = options?.mode ?? 'incremental'
  const progress = options?.progress ?? (() => {})
  const startTime = Date.now()

  if (!config.adrEnabled) {
    return { filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0, filesSkipped: 0, durationMs: 0 }
  }

  progress('检查 Milvus ADR 集合...')
  await milvus.ensureAdrCollection()

  progress('扫描 ADR 目录...')
  const adrRoot = config.adrRoot
  let adrFiles: string[]
  try {
    adrFiles = (await readdir(adrRoot))
      .filter(f => ADR_FILE_RE.test(f))
      .map(f => path.join(adrRoot, f))
  } catch {
    return { filesIndexed: 0, chunksIndexed: 0, filesRemoved: 0, chunksRemoved: 0, filesSkipped: 0, durationMs: 0 }
  }

  // Compute hashes
  const currentFiles = new Map<string, string>()
  for (const filePath of adrFiles) {
    const content = await readFile(filePath, 'utf-8')
    const hash = HashTracker.hashContent(content)
    currentFiles.set(filePath, hash)
  }

  // Compute delta
  let delta: { toIndex: string[]; toRemove: string[]; unchanged: string[] }
  if (mode === 'full') {
    delta = { toIndex: adrFiles, toRemove: [], unchanged: [] }
  } else {
    delta = tracker.computeDelta(currentFiles)
  }

  // Remove deleted files
  let chunksRemoved = 0
  if (delta.toRemove.length > 0) {
    progress(`移除已删除 ADR: ${delta.toRemove.length} 个...`)
    for (const filePath of delta.toRemove) {
      chunksRemoved += await milvus.deleteAdrByFilePath(filePath)
    }
    tracker.removeRecords(delta.toRemove)
    // Remove from anchor index
    for (const filePath of delta.toRemove) {
      const basename = path.basename(filePath)
      const adrId = basename.replace(/\.md$/, '')
      anchorIndex.removeAdr(adrId)
    }
  }

  // Index changed files
  const embeddingClient = new EmbeddingClient(config.embedding)
  let filesIndexed = 0
  let chunksIndexed = 0

  if (delta.toIndex.length > 0) {
    progress(`索引 ${delta.toIndex.length} 个 ADR 文件...`)
    for (const filePath of delta.toIndex) {
      try {
        const content = await readFile(filePath, 'utf-8')
        const hash = currentFiles.get(filePath) ?? HashTracker.hashContent(content)

        const chunks = await chunkAdrFile(filePath, content)
        if (chunks.length === 0) {
          tracker.updateRecord(filePath, hash, 0)
          continue
        }

        // Get embeddings
        const texts = chunks.map(c => c.content)
        const vectors = await embeddingClient.embed(texts)
        if (vectors.length !== chunks.length) {
          throw new Error(`Embedding mismatch: ${vectors.length} vectors for ${chunks.length} chunks`)
        }

        // Insert with vectors
        const chunksWithVectors = chunks.map((chunk, i) => ({ ...chunk, vector: vectors[i] }))
        if (mode === 'incremental') {
          await milvus.deleteAdrByFilePath(filePath)
        }
        const inserted = await milvus.insertAdrChunks(chunksWithVectors)

        // Update anchor index
        const adrId = path.basename(filePath).replace(/\.md$/, '')
        const anchorFiles = chunks.length > 0 ? chunks[0].codeAnchors : []
        anchorIndex.setAdr(adrId, anchorFiles)

        tracker.updateRecord(filePath, hash, inserted)
        filesIndexed++
        chunksIndexed += inserted
      } catch (err) {
        progress(`  失败: ${path.basename(filePath)} — ${(err as Error).message}`)
      }
    }
  }

  // Save state
  await tracker.save()
  await anchorIndex.save()

  return {
    filesIndexed,
    chunksIndexed,
    filesRemoved: delta.toRemove.length,
    chunksRemoved,
    filesSkipped: delta.unchanged.length,
    durationMs: Date.now() - startTime,
  }
}

export async function getAdrIndexStatus(
  tracker: HashTracker,
  adrService: AdrService,
): Promise<AdrIndexStatus> {
  const stats = tracker.getStats()
  const lastIndexedTs = tracker.getLastIndexedTimestamp()

  // Count active ADRs by scanning the ADR directory
  let activeAdrs = 0
  try {
    const all = await adrService.listAdrs({ status: 'all', limit: 10000 })
    activeAdrs = all.filter(a => a.status === 'active').length
  } catch {
    activeAdrs = 0
  }

  return {
    totalAdrs: stats.totalFiles,
    totalChunks: stats.totalChunks,
    lastIndexed: lastIndexedTs ? new Date(lastIndexedTs).toISOString() : '',
    activeAdrs,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/adr-indexer.spec.ts -v`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/adr-indexer.ts test/adr-indexer.spec.ts
git commit -m "feat: add ADR indexing pipeline"
```

---
### Task 8: ADR Tools

**Files:**
- Create: `src/plugins/dsh-context-milvus/adr-tools.ts`
- Create: `test/adr-tools.spec.ts`

**Interfaces:**
- Consumes: `ctx`, `MilvusService`, `AdrService`, `AdrAnchorIndex`, `PluginConfig`, `defineTool()`
- Produces: `registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)` — registers 7 tools

- [ ] **Step 1: Write the failing test**

```typescript
// test/adr-tools.spec.ts
import { jest } from '@jest/globals'

// Mock dsh-tools
const mockRegister = jest.fn()
const mockDefineTool = jest.fn((opts: any) => opts)

jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: mockDefineTool,
}))

const { registerAdrTools } = await import('../src/plugins/dsh-context-milvus/adr-tools.js')

describe('registerAdrTools', () => {
  let ctx: any
  let milvus: any
  let adrService: any
  let anchorIndex: any
  let resolveConfig: any

  beforeEach(() => {
    jest.clearAllMocks()
    ctx = { tools: { register: mockRegister } }
    milvus = {
      searchAdr: jest.fn().mockResolvedValue([]),
      ensureAdrCollection: jest.fn().mockResolvedValue(undefined),
    }
    adrService = {
      createAdr: jest.fn().mockResolvedValue({ id: 'ADR-0001-test', filePath: '/test.md' }),
      updateAdr: jest.fn().mockResolvedValue({ id: 'ADR-0001-test', filePath: '/test.md' }),
      listAdrs: jest.fn().mockResolvedValue([]),
      loadAdr: jest.fn().mockResolvedValue(null),
      getActiveConstraints: jest.fn().mockResolvedValue([]),
    }
    anchorIndex = {
      getAdrsForFile: jest.fn().mockReturnValue([]),
      getStats: jest.fn().mockReturnValue({ adrCount: 0, anchorCount: 0 }),
    }
    resolveConfig = jest.fn().mockReturnValue({ adrEnabled: true })
  })

  it('registers 7 tools when adrEnabled is true', () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    expect(mockRegister).toHaveBeenCalledTimes(7)
  })

  it('registers no tools when adrEnabled is false', () => {
    resolveConfig.mockReturnValue({ adrEnabled: false })
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    expect(mockRegister).not.toHaveBeenCalled()
  })

  it('search_adr tool calls milvus.searchAdr', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const searchAdrDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr')?.[0]
    expect(searchAdrDef).toBeDefined()
    await searchAdrDef.execute({ query: 'test query', topK: 3 })
    expect(milvus.searchAdr).toHaveBeenCalledWith('test query', 3, undefined)
  })

  it('search_adr passes path prefix filter', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const searchAdrDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr')?.[0]
    await searchAdrDef.execute({ query: 'test', path: '/workspace/project', status: 'active' })
    expect(milvus.searchAdr).toHaveBeenCalledWith('test', 5, { status: 'active', pathPrefix: '/workspace/project' })
  })

  it('search_adr_by_file calls anchorIndex.getAdrsForFile', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'search_adr_by_file')?.[0]
    expect(toolDef).toBeDefined()
    anchorIndex.getAdrsForFile.mockReturnValue(['ADR-0001'])
    adrService.loadAdr.mockResolvedValue({ frontmatter: { id: 'ADR-0001' }, sections: { '决策目标': 'test' } })
    await toolDef.execute({ file_path: 'src/test.ts' })
    expect(anchorIndex.getAdrsForFile).toHaveBeenCalledWith('src/test.ts')
  })

  it('create_adr calls adrService.createAdr', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'create_adr')?.[0]
    await toolDef.execute({ title: 'test' })
    expect(adrService.createAdr).toHaveBeenCalledWith({ title: 'test' })
  })

  it('list_adrs calls adrService.listAdrs', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'list_adrs')?.[0]
    await toolDef.execute({ status: 'active' })
    expect(adrService.listAdrs).toHaveBeenCalledWith({ status: 'active', limit: 100 })
  })

  it('check_adr_consistency checks anchors', async () => {
    registerAdrTools(ctx, resolveConfig, milvus, adrService, anchorIndex)
    const toolDef = mockRegister.mock.calls.find((c: any) => c[0].name === 'check_adr_consistency')?.[0]
    const result = await toolDef.execute({})
    expect(result).toHaveProperty('staleAnchors')
    expect(result).toHaveProperty('uncoveredChanges')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/adr-tools.spec.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `adr-tools.ts`**

```typescript
// src/plugins/dsh-context-milvus/adr-tools.ts
import * as path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MilvusService } from './milvus-service.js'
import type { AdrService } from './adr-service.js'
import type { AdrAnchorIndex } from './adr-anchor-index.js'
import type { PluginConfig } from './config.js'
import type { HashTracker } from './merkle.js'
import type { AdrIndexResult } from './adr-indexer.js'
import { runAdrIndex } from './adr-indexer.js'

/** Format ADR search results for model consumption */
function formatAdrSearchResults(value: any[]): string {
  if (value.length === 0) return '未找到匹配的 ADR 决策记录。'
  return value.map((item: any, i: number) => {
    return [
      `[结果 ${i + 1}] ADR: ${item.adrId} (${item.status}), 章节: ${item.section}`,
      `文件: ${item.filePath}`,
      `相关度: ${item.score.toFixed(4)}`,
      `内容:`,
      item.content,
    ].join('\n')
  }).join('\n---\n')
}

export function registerAdrTools(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  milvus: MilvusService,
  adrService: AdrService,
  anchorIndex: AdrAnchorIndex,
  adrIndexer?: {  // NEW: for auto-indexing after create/update
    runAdrIndex: typeof runAdrIndex
    tracker: HashTracker
  },
): void {
  const config = resolveConfig()
  if (!config.adrEnabled) return

  // ── search_adr ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'search_adr',
    description: '在 ADR 决策记录中执行语义搜索。当需要了解某段代码的"为什么"时使用此工具。',
    parameters: {
      query: { type: 'string', required: true, description: '自然语言查询，如"为什么用了重试队列"' },
      path: { type: 'string', description: '限定 ADR 搜索路径范围（传递给 Milvus 的 pathPrefix 过滤）' },
      status: { type: 'string', description: '过滤状态: active | superseded | deprecated | all' },
      topK: { type: 'number', description: '返回结果数量，默认 5' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            adrId: { type: 'string' }, filePath: { type: 'string' },
            status: { type: 'string' }, section: { type: 'string' },
            content: { type: 'string' }, score: { type: 'number' },
            triggerType: { type: 'string' },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => [{ type: 'text' as const, text: formatAdrSearchResults(value as any[]) }],
    },
    async execute(params: any) {
      await milvus.ensureAdrCollection()
      const filters: any = {}
      if (params.status && params.status !== 'all') filters.status = params.status
      if (params.path) filters.pathPrefix = params.path
      return milvus.searchAdr(params.query, params.topK ?? 5, Object.keys(filters).length > 0 ? filters : undefined)
    },
  }))

  // ── search_adr_by_file ──────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'search_adr_by_file',
    description: '通过代码文件路径查找相关的 ADR 决策记录。基于 code_anchors 确定性关联。',
    parameters: {
      file_path: { type: 'string', required: true, description: '代码文件路径' },
      status: { type: 'string', description: '过滤状态' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            adrId: { type: 'string' }, filePath: { type: 'string' },
            status: { type: 'string' }, summary: { type: 'string' },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => {
        if (value.length === 0) return [{ type: 'text' as const, text: '未找到关联的 ADR 决策记录。' }]
        const text = value.map((v: any) =>
          `- ${v.adrId} (${v.status}): ${v.summary?.slice(0, 100) || ''}`
        ).join('\n')
        return [{ type: 'text' as const, text: `关联的 ADR 决策记录:\n${text}` }]
      },
    },
    async execute(params: any) {
      const adrIds = anchorIndex.getAdrsForFile(params.file_path)
      if (adrIds.length === 0) return []
      const results = []
      for (const adrId of adrIds) {
        const doc = await adrService.loadAdr(adrId)
        if (doc && (!params.status || params.status === 'all' || doc.frontmatter.status === params.status)) {
          const firstSection = Object.values(doc.sections)[0] || ''
          results.push({
            adrId: doc.frontmatter.id,
            filePath: doc.filePath,
            status: doc.frontmatter.status,
            summary: firstSection.slice(0, 200),
          })
        }
      }
      return results
    },
  }))

  // ── create_adr ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'create_adr',
    description: '创建新的 ADR 决策记录。当做出新设计决策、引入新依赖或架构变更时使用。',
    parameters: {
      title: { type: 'string', required: true, description: 'kebab-case 简短描述，如 webhook-dead-letter-queue' },
      requirement: { type: 'string', description: '触发需求/变更描述' },
      change_type: { type: 'string', description: 'new_feature | refactor | bugfix | optimization | architecture' },
      supersedes: { type: 'string', description: '被替代的 ADR id' },
      content: { type: 'string', description: '自定义内容（留空则用模板自动生成）' },
    },
    output: {
      schema: {
        type: 'object', properties: {
          adrId: { type: 'string' }, filePath: { type: 'string' },
        }, additionalProperties: false,
      },
      render: (_args: any, value: any) => [
        { type: 'text' as const, text: `✅ ADR 已创建: ${value.adrId}\n路径: ${value.filePath}` },
      ],
    },
    async execute(params: any) {
      const result = await adrService.createAdr({
        title: params.title,
        requirement: params.requirement,
        changeType: params.change_type,
        supersedes: params.supersedes,
        content: params.content,
      })
      // Auto-index the newly created ADR
      if (adrIndexer) {
        const config = resolveConfig()
        const adrConfig = { ...config, adrRoot: path.resolve(config.indexRoot, config.adrRoot) }
        await adrIndexer.runAdrIndex(adrConfig, milvus, adrIndexer.tracker, anchorIndex, { mode: 'incremental' })
      }
      return { adrId: result.id, filePath: result.filePath }
    },
  }))

  // ── update_adr ──────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'update_adr',
    description: '更新已有 ADR 决策记录。修改约束、变更状态或补充内容时使用。',
    parameters: {
      adr_id: { type: 'string', required: true, description: 'ADR id，如 ADR-0001-test' },
      content: { type: 'string', description: '替换正文' },
      status: { type: 'string', description: '变更状态: active | superseded | deprecated' },
      superseded_by: { type: 'string', description: '标记被谁替代' },
      merge: { type: 'boolean', description: 'true 则合并内容（保留未传字段）' },
    },
    output: {
      schema: {
        type: 'object', properties: {
          adrId: { type: 'string' }, filePath: { type: 'string' },
        }, additionalProperties: false,
      },
      render: (_args: any, value: any) => [
        { type: 'text' as const, text: `✅ ADR 已更新: ${value.adrId}` },
      ],
    },
    async execute(params: any) {
      const result = await adrService.updateAdr(params.adr_id, {
        content: params.content,
        status: params.status,
        supersededBy: params.superseded_by,
        merge: params.merge,
      })
      // Re-index the updated ADR
      if (adrIndexer) {
        const config = resolveConfig()
        const adrConfig = { ...config, adrRoot: path.resolve(config.indexRoot, config.adrRoot) }
        await adrIndexer.runAdrIndex(adrConfig, milvus, adrIndexer.tracker, anchorIndex, { mode: 'incremental' })
      }
      return { adrId: result.id, filePath: result.filePath }
    },
  }))

  // ── list_adrs ───────────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'list_adrs',
    description: '列出 ADR 决策记录目录。可按状态和变更类型过滤。',
    parameters: {
      status: { type: 'string', description: '过滤: active | superseded | deprecated | all (默认 active)' },
      change_type: { type: 'string', description: '过滤触发类型' },
      limit: { type: 'number', description: '结果数量限制，默认 100' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            id: { type: 'string' }, filePath: { type: 'string' },
            status: { type: 'string' }, created: { type: 'string' },
            anchorCount: { type: 'number' }, summary: { type: 'string' },
            changeType: { type: 'string' },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => {
        if (value.length === 0) return [{ type: 'text' as const, text: '没有找到匹配的 ADR。' }]
        const text = value.map((v: any) =>
          `${v.id} [${v.status}] ${v.changeType} — ${v.summary?.slice(0, 60) || ''}`
        ).join('\n')
        const counts = `共 ${value.length} 条 ADR 记录`
        return [{ type: 'text' as const, text: `${counts}\n${text}` }]
      },
    },
    async execute(params: any) {
      return adrService.listAdrs({
        status: params.status ?? 'active',
        changeType: params.change_type,
        limit: params.limit ?? 100,
      })
    },
  }))

  // ── load_constraints ────────────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'load_constraints',
    description: '加载当前 active ADR 的约束条件，包括隐性约束和被否决的反模式。',
    parameters: {
      adr_ids: { type: 'string', description: '指定 ADR id（逗号分隔），不传则加载所有 active' },
      format: { type: 'string', description: 'summary | full（默认 summary）' },
    },
    output: {
      schema: {
        type: 'array', items: {
          type: 'object', properties: {
            adrId: { type: 'string' }, adrTitle: { type: 'string' },
            constraints: { type: 'array', items: { type: 'string' } },
            rejectedPatterns: { type: 'array', items: { type: 'string' } },
          }, additionalProperties: false,
        },
      },
      render: (_args: any, value: any) => {
        if (value.length === 0) return [{ type: 'text' as const, text: '没有 active 的约束。' }]
        const parts = value.map((v: any) => {
          const lines = [`## ${v.adrId}: ${v.adrTitle}`]
          if (v.constraints.length > 0) lines.push('约束:', ...v.constraints.map((c: string) => `  - ${c}`))
          if (v.rejectedPatterns.length > 0) lines.push('被否决的反模式:', ...v.rejectedPatterns.map((p: string) => `  ❌ ${p}`))
          return lines.join('\n')
        })
        return [{ type: 'text' as const, text: parts.join('\n\n') }]
      },
    },
    async execute(params: any) {
      const all = await adrService.getActiveConstraints()
      if (params.adr_ids) {
        const ids = params.adr_ids.split(',').map((s: string) => s.trim())
        return all.filter(c => ids.includes(c.adrId))
      }
      return all
    },
  }))

  // ── check_adr_consistency ───────────────────────────────────────────────
  ctx.tools.register(defineTool({
    name: 'check_adr_consistency',
    description: '检查 ADR 决策记录与代码的一致性。验证 code_anchors 是否仍然有效，检测未覆盖的变更。',
    parameters: {
      file_path: { type: 'string', description: '检查特定文件（不传则检查所有）' },
      fix: { type: 'boolean', description: '尝试自动修复失效锚点' },
    },
    output: {
      schema: {
        type: 'object', properties: {
          staleAnchors: { type: 'array', items: { type: 'object', properties: { adrId: { type: 'string' }, file: { type: 'string' }, issue: { type: 'string' } }, additionalProperties: false } },
          uncoveredChanges: { type: 'array', items: { type: 'object', properties: { adrId: { type: 'string' }, file: { type: 'string' }, status: { type: 'string' } }, additionalProperties: false } },
        }, additionalProperties: false,
      },
      render: (_args: any, value: any) => {
        const parts: string[] = ['## ADR 一致性检查结果']
        if (value.staleAnchors?.length > 0) {
          parts.push(`\n### 失效锚点 (${value.staleAnchors.length})`)
          value.staleAnchors.forEach((a: any) => parts.push(`  - ${a.adrId}: ${a.file} — ${a.issue}`))
        }
        if (value.uncoveredChanges?.length > 0) {
          parts.push(`\n### 未覆盖变更 (${value.uncoveredChanges.length})`)
          value.uncoveredChanges.forEach((a: any) => parts.push(`  - ${a.adrId}: ${a.file} — ${a.status}`))
        }
        if (!value.staleAnchors?.length && !value.uncoveredChanges?.length) {
          parts.push('\n✅ 未发现问题，所有 ADR 与代码一致。')
        }
        return [{ type: 'text' as const, text: parts.join('\n') }]
      },
    },
    async execute(params: any) {
      const staleAnchors: Array<{ adrId: string; file: string; issue: string }> = []
      const uncoveredChanges: Array<{ adrId: string; file: string; status: string }> = []

      const allFiles = anchorIndex.getAll()
      for (const [filePath, adrIds] of allFiles) {
        if (params.file_path && filePath !== params.file_path) continue
        // Check if file exists
        try {
          const { access } = await import('node:fs/promises')
          await access(filePath)
        } catch {
          staleAnchors.push({ adrId: adrIds.join(', '), file: filePath, issue: '文件已不存在' })
        }
      }

      return { staleAnchors, uncoveredChanges }
    },
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/adr-tools.spec.ts -v`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/adr-tools.ts test/adr-tools.spec.ts
git commit -m "feat: add 7 ADR tools (search, CRUD, constraints, consistency)"
```

---
### Task 9: Constraint Injector (System Prompt + Lifecycle Hooks)

**Files:**
- Create: `src/plugins/dsh-context-milvus/constraint-injector.ts`
- Create: `test/constraint-injector.spec.ts`

**Interfaces:**
- Consumes: `ctx`, `PluginConfig`, `AdrService`, `AdrAnchorIndex`, `SystemPrompt` service
- Produces: `setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)` — registers system prompt section, context provider, and lifecycle hooks

- [ ] **Step 1: Write the failing test**

```typescript
// test/constraint-injector.spec.ts
import { jest } from '@jest/globals'

const { setupConstraintInjection } = await import('../src/plugins/dsh-context-milvus/constraint-injector.js')

describe('setupConstraintInjection', () => {
  let ctx: any
  let adrService: any
  let anchorIndex: any
  let resolveConfig: any
  let sectionResult: any
  let contextResult: any

  beforeEach(() => {
    sectionResult = null
    contextResult = null
    ctx = {
      systemPrompt: {
        section: jest.fn((s: any) => { sectionResult = s }),
        context: jest.fn((c: any) => { contextResult = c }),
      },
      on: jest.fn(),
    }
    adrService = {
      getActiveConstraints: jest.fn().mockResolvedValue([
        { adrId: 'ADR-0001', adrTitle: 'Test', constraints: ['Must be fast'], rejectedPatterns: ['❌ no X'] },
      ]),
    }
    anchorIndex = {
      getAdrsForFile: jest.fn().mockReturnValue(['ADR-0001']),
    }
    resolveConfig = jest.fn().mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 5,
      adrSystemPrompt: '',
    })
  })

  it('registers a system prompt section', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.section).toHaveBeenCalled()
    expect(sectionResult.name).toBe('decision-memory:rules')
    expect(sectionResult.order).toBe(50)
  })

  it('registers a runtime context provider', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.context).toHaveBeenCalled()
    expect(contextResult.name).toBe('decision-memory:active-constraints')
  })

  it('registers agent/pre-step hook', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function))
  })

  it('registers tools/result hook', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.on).toHaveBeenCalledWith('tools/result', expect.any(Function))
  })

  it('does nothing when adrEnabled is false', () => {
    resolveConfig.mockReturnValue({ adrEnabled: false })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled()
    expect(ctx.on).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest test/constraint-injector.spec.ts -v`
Expected: FAIL — module not found

- [ ] **Step 3: Implement `constraint-injector.ts`**

```typescript
// src/plugins/dsh-context-milvus/constraint-injector.ts
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { PluginConfig } from './config.js'
import type { AdrService } from './adr-service.js'
import type { AdrAnchorIndex } from './adr-anchor-index.js'

const DEFAULT_SYSTEM_PROMPT = `## 决策记忆系统规则

你是本项目的 AI 编码 Agent。本项目部署了决策因果记忆系统（Decision Causal Memory System）。

### 你必须遵守的规则：

1. **开始任何任务前**：
   - 检查 docs/decisions/ 中是否有 ADR 决策记录覆盖了你将要修改的文件
   - 使用 search_adr_by_file 工具查找相关 ADR

2. **执行代码变更时**：
   - 如变更触发 ADR 产出条件（新模块/核心逻辑修改/新依赖/非常规bugfix/架构变更/删除逻辑）
   - 必须使用 create_adr 或 update_adr 工具生成或更新对应的 ADR

3. **完成任务前**：
   - 使用 check_adr_consistency 确认 ADR 与代码一致
   - 确认隐性约束和被否决的反模式字段已填写完整

4. **禁止行为**：
   - ❌ 跳过 ADR 产出（声称"这是小改动"）
   - ❌ 生成只有 WHAT 没有 WHY 的空洞 ADR
   - ❌ 忽略已加载 ADR 中的隐性约束
   - ❌ 重新尝试已被 ADR 否决的方案`

/**
 * Memory cache for constraint summary.
 * Refreshed asynchronously in the pre-step hook; read synchronously by systemPrompt.context().
 */
let constraintCache = ''

/**
 * Per-session state for constraint re-injection tracking.
 */
const sessionState = new WeakMap<object, { stepCount: number; pendingWarnings: string[] }>()

/**
 * Build constraint summary text from active ADR constraints.
 */
function buildConstraintSummary(constraints: Array<{ adrId: string; adrTitle: string; constraints: string[]; hiddenConstraints: Array<{ name: string; content: string; consequence: string }>; rejectedPatterns: string[] }>): string {
  if (constraints.length === 0) return ''
  const parts = constraints.map(c => {
    const items: string[] = []
    if (c.constraints.length > 0) items.push('约束: ' + c.constraints.join('; '))
    if (c.hiddenConstraints.length > 0) {
      items.push('隐性约束: ' + c.hiddenConstraints.map(h => h.name + ' — ' + h.content).join('; '))
    }
    if (c.rejectedPatterns.length > 0) items.push('禁止反模式: ' + c.rejectedPatterns.join('; '))
    return `${c.adrId}: ${items.join(' | ')}`
  })
  return `当前 Active ADR 约束摘要:\n${parts.join('\n')}`
}

/**
 * Set up system prompt injection, constraint re-injection, and file-change tracking.
 */
export function setupConstraintInjection(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  adrService: AdrService,
  anchorIndex: AdrAnchorIndex,
): void {
  const config = resolveConfig()
  if (!config.adrEnabled) return

  // ── 1. Register system prompt section ───────────────────────────────────
  if (ctx.systemPrompt?.section) {
    const promptText = config.adrSystemPrompt || DEFAULT_SYSTEM_PROMPT
    ctx.systemPrompt.section({
      name: 'decision-memory:rules',
      order: 50,
      text: promptText,
    })

    // ── 2. Register runtime context provider (sync — reads cache) ──────────
    ctx.systemPrompt.context({
      name: 'decision-memory:active-constraints',
      order: 50,
      text: () => constraintCache,
    })
  }

  // ── 3. Register pre-step hook for constraint re-injection ────────────────
  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    // Run the next middleware first
    const decision = await next()
    if (!decision || decision.kind === 'reject') return decision

    // Get or create per-session state
    const session = agent.session
    let state = sessionState.get(session)
    if (!state) {
      state = { stepCount: 0, pendingWarnings: [] }
      sessionState.set(session, state)
    }
    state.stepCount++

    const reinjectEvery = resolveConfig().adrConstraintReinjectEvery
    const warnings: string[] = [...state.pendingWarnings]
    state.pendingWarnings = []

    // Async refresh constraint cache and check re-injection
    if (reinjectEvery > 0 && state.stepCount % reinjectEvery === 0) {
      try {
        const constraints = await adrService.getActiveConstraints()
        constraintCache = buildConstraintSummary(constraints)
        if (constraints.length > 0) {
          warnings.push(`⚠️ 约束复查提醒（第 ${state.stepCount} 步）:\n${constraintCache}`)
        }
      } catch {
        // Silently handle errors
      }
    }

    // Inject warnings as user-role messages using createUserMessage
    if (warnings.length > 0) {
      const warningText = warnings.join('\n\n')
      const warningMessage = createUserMessage({
        content: [{ type: 'text', text: warningText }],
        source: { kind: 'plugin', plugin: 'dsh-context-milvus' },
      })

      // Find the last claimed message index and insert after it
      // (following the same pattern as dsh-agent-instructions)
      const lastClaimedIndex = decision.messages.findLastIndex(
        (m: any) => messages.includes(m)
      )
      return {
        ...decision,
        messages: decision.messages.toSpliced(lastClaimedIndex + 1, 0, warningMessage),
      }
    }

    return decision
  })

  // ── 4. Register tools/result hook for file-change tracking ──────────────
  const FILE_TOOL_NAMES = new Set(['read', 'write', 'edit'])
  ctx.on('tools/result', (exec: any, result: any) => {
    if (!exec.agent || !result || result.isError) return
    if (!FILE_TOOL_NAMES.has(exec.name)) return

    // Extract file path from arguments
    const filePath = exec.arguments?.file_path as string | undefined
    if (!filePath) return

    // Check if file is in anchor index
    const adrIds = anchorIndex.getAdrsForFile(filePath)
    if (adrIds.length === 0) return

    // Add warning to session state
    const session = exec.agent.session
    let state = sessionState.get(session)
    if (!state) {
      state = { stepCount: 0, pendingWarnings: [] }
      sessionState.set(session, state)
    }
    state.pendingWarnings.push(
      `⚠️ 你修改了文件 ${filePath}，它被以下 ADR 的 code_anchors 覆盖: ${adrIds.join(', ')}。请确认是否需要更新相关 ADR 的约束条件或 code_anchors。`,
    )
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest test/constraint-injector.spec.ts -v`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/constraint-injector.ts test/constraint-injector.spec.ts
git commit -m "feat: add constraint injector (system prompt + lifecycle hooks)"
```

---
### Task 10: Entry Point Assembly

**Files:**
- Modify: `src/plugins/dsh-context-milvus/index.ts`
- Modify: `test/dsh-context-remdb.spec.ts` (add integration tests)

- [ ] **Step 1: Extend `index.ts` Config schema**

Add to the `Config` object in `index.ts`:
```typescript
/** 启用 ADR 决策记忆功能 */
adrEnabled: z.boolean()
  .default(true)
  .description('启用 ADR 决策记忆功能（索引/docs/decisions/中的决策记录）'),

/** ADR 目录路径 */
adrRoot: z.string()
  .default('docs/decisions')
  .description('ADR 决策记录目录（相对 indexRoot）'),

/** ADR Milvus 集合名称 */
adrCollection: z.string()
  .default('adr_embeddings')
  .description('Milvus 集合名称，用于存储 ADR 向量'),

/** 约束重注入步数间隔 */
adrConstraintReinjectEvery: z.number()
  .default(5)
  .description('约束重注入步数间隔（每 N 步重新注入 active ADR 约束，0=禁用）')
  .min(0),

/** 自定义系统提示段落 */
adrSystemPrompt: z.string()
  .default('')
  .description('自定义 ADR 系统提示段落（留空使用内置模板）')
  .role('textarea'),
```

- [ ] **Step 2: Add static imports to `index.ts`**

Add at the top of `index.ts`:
```typescript
import { AdrAnchorIndex } from './adr-anchor-index.js'
import { AdrService } from './adr-service.js'
import { registerAdrTools } from './adr-tools.js'
import { runAdrIndex } from './adr-indexer.js'
import { setupConstraintInjection } from './constraint-injector.js'
import { HashTracker } from './merkle.js'
```

- [ ] **Step 3: Extend `apply()` in `index.ts`**

After the existing initialization code and before the console.log, add:
```typescript
// ── ADR (Decision Memory) initialization ──────────────────────────────
const adrResolved = getConfig(current())
if (adrResolved.adrEnabled) {
  // Resolve ADR root (relative to indexRoot)
  const adrRoot = path.resolve(adrResolved.indexRoot, adrResolved.adrRoot)

  // Initialize ADR services
  const anchorIndex = new AdrAnchorIndex(
    deriveMerkleFilePath(adrRoot).replace('merkle', 'anchors')
  )
  await anchorIndex.load().catch(() => {})

  const adrService = new AdrService(adrRoot)

  // Create ADR-specific HashTracker for incremental indexing
  const adrTracker = new HashTracker(
    deriveMerkleFilePath(adrRoot).replace('merkle', 'adr-merkle')
  )
  await adrTracker.load().catch(() => {})

  // Register ADR tools (with auto-indexing support)
  registerAdrTools(ctx, () => getConfig(current()), milvus, adrService, anchorIndex, {
    runAdrIndex,
    tracker: adrTracker,
  })

  // Set up constraint injection (system prompt + lifecycle hooks)
  setupConstraintInjection(ctx, () => getConfig(current()), adrService, anchorIndex)

  console.log(`[dsh-context-milvus] ADR 决策记忆已加载 (${adrRoot})`)
}
```

- [ ] **Step 4: Run all tests to confirm nothing is broken**

Run: `npx jest --no-coverage`
Expected: All tests PASS (existing + new)

- [ ] **Step 5: Wire ADR indexing into `index_code` tool**

The `index_code` tool needs to also index ADRs when ADR is enabled. This requires modifying `tools.ts`'s `registerTools` signature to accept optional ADR indexing services.

Update `tools.ts` imports:
```typescript
import { runAdrIndex, getAdrIndexStatus as getAdrIndexStatusFn } from './adr-indexer.js'
import type { AdrService } from './adr-service.js'
import type { AdrAnchorIndex } from './adr-anchor-index.js'
```

Update `registerTools` signature:
```typescript
export function registerTools(
  ctx: Context,
  resolveConfig: () => PluginConfig,
  milvus: MilvusService,
  tracker: HashTracker,
  adrOptions?: {                          // NEW: optional ADR options
    service: AdrService
    anchorIndex: AdrAnchorIndex
    adrTracker: HashTracker
  },
): void {
```

In `index_code`'s execute, after the existing code indexing logic, add ADR indexing:
```typescript
// After code indexing, also index ADRs if enabled
if (adrOptions && config.adrEnabled) {
  const adrConfig = {
    ...config,
    adrRoot: path.resolve(config.indexRoot, config.adrRoot),
  }
  const adrResult = await runAdrIndex(
    adrConfig, milvus, adrOptions.adrTracker, adrOptions.anchorIndex,
    { mode, progress: (msg) => progress(msg) },
  )
  progress(`  ADR 索引: ${adrResult.filesIndexed} 个文件, ${adrResult.chunksIndexed} 个代码块`)
}
```

In `index.ts` `apply()`, create an ADR-specific HashTracker and pass it to registerTools:
```typescript
// In the ADR initialization block, after creating anchorIndex and adrService:
const adrTracker = new HashTracker(
  deriveMerkleFilePath(adrRoot).replace('merkle', 'adr-merkle')
)
await adrTracker.load().catch(() => {})

// Update registerTools call to pass ADR options:
registerTools(ctx, () => getConfig(current()), milvus, tracker, {
  service: adrService,
  anchorIndex,
  adrTracker,
})
```

- [ ] **Step 6: Update `index_status` to include ADR info**

In `tools.ts` index_status execute, also fetch ADR index status when ADR is enabled:
```typescript
// Append ADR status if available
if (adrOptions && config.adrEnabled) {
  const adrStatus = await getAdrIndexStatusFn(adrOptions.adrTracker, adrOptions.service)
  v.adrTotalAdrs = adrStatus.totalAdrs
  v.adrActiveAdrs = adrStatus.activeAdrs
  v.adrLastIndexed = adrStatus.lastIndexed
}
```

Update the render function to show ADR status.

- [ ] **Step 7: Run all tests and build**

Run: `npx jest --no-coverage`
Expected: All tests PASS
Run: `npm run build`
Expected: Compilation succeeds

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/index.ts
git commit -m "feat: wire ADR modules into plugin entry point"
```

---
### Task 11: Documentation Update

**Files:**
- Modify: `AGENTS.md` — add new tool descriptions
- Modify: `CLAUDE.md` — add ADR commands and architecture section
- Modify: `README.md` — add decision memory feature documentation

- [ ] **Step 1: Update `AGENTS.md`**

Append to the tools table:
```markdown
| `search_adr` | 语义搜索 ADR 决策记录，了解代码的"为什么" | `query`(必填)、`status`、`topK` |
| `search_adr_by_file` | 通过代码文件路径查找关联的 ADR 决策记录 | `file_path`(必填)、`status` |
| `create_adr` | 创建新的 ADR 决策记录 | `title`(必填)、`requirement`、`change_type` |
| `update_adr` | 更新已有 ADR 决策记录 | `adr_id`(必填)、`content`、`status` |
| `list_adrs` | 列出 ADR 决策记录目录 | `status`、`change_type`、`limit` |
| `load_constraints` | 加载 active ADR 的约束条件 | `adr_ids`、`format` |
| `check_adr_consistency` | 检查 ADR 与代码的一致性 | `file_path`、`fix` |
```

Also add usage rules:
```markdown
## ADR 决策记忆使用规则

1. **修改代码前**，先调用 `search_adr_by_file` 确认该文件是否有 ADR 决策记录覆盖
2. **做出设计决策**（新功能/重构/架构变更/新依赖）时，使用 `create_adr` 记录决策原因
3. **修改了被 ADR 覆盖的代码**后，使用 `update_adr` 更新对应 ADR 的 code_anchors
4. **任务完成前**，调用 `check_adr_consistency` 确认一致性
5. **需要了解约束**时，使用 `load_constraints` 查看 active ADR 的约束条件
```

- [ ] **Step 2: Update `CLAUDE.md`**

Add to the Architecture section:
```markdown
### ADR 决策记忆系统（新增模块）

```
adr-frontmatter.ts   YAML frontmatter 解析
adr-chunker.ts       Markdown 章节分块
adr-anchor-index.ts  code_anchors 反向索引
adr-service.ts       ADR CRUD + 状态管理
adr-indexer.ts       ADR 索引管道
adr-tools.ts         7 个 ADR 工具
constraint-injector.ts  系统提示注入 + 约束重注入
```

Milvus 集合: `adr_embeddings`（与 `code_embeddings` 分离，含 adr_id/status/section/code_anchors 字段）
```

Add test commands:
```bash
# Test ADR modules
npx jest test/adr-frontmatter.spec.ts
npx jest test/adr-chunker.spec.ts
npx jest test/adr-anchor-index.spec.ts
npx jest test/adr-service.spec.ts
npx jest test/adr-indexer.spec.ts
npx jest test/adr-tools.spec.ts
npx jest test/constraint-injector.spec.ts
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md CLAUDE.md
git commit -m "docs: update AGENTS.md and CLAUDE.md with ADR decision memory system"
```

---