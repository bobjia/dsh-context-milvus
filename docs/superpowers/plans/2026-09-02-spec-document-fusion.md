# Spec Document Fusion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Index brainstorming spec/plan documents into the shared `adr_embeddings` Milvus collection with auto-generated code_anchors, making them searchable alongside ADRs.

**Architecture:** Extend the existing ADR indexing pipeline (adr-indexer.ts) to scan three roots (ADR + spec + plan). Add a new `adr-anchor-generator.ts` module that detects code references in spec text and generates YAML frontmatter with code_anchors. Add an `index_specs` tool for post-processing. The `doc_type` field distinguishes ADR vs spec vs plan chunks in the shared collection.

**Tech Stack:** TypeScript, Milvus (via `@zilliz/milvus2-sdk-node`), tree-sitter (existing), js-yaml (existing), jest (testing)

## Global Constraints

- `docType` values: `"adr"` | `"spec"` | `"plan"` — mapped from frontmatter `type` field (`decision-record` → `adr`, `spec` → `spec`, `plan` → `plan`)
- Spec frontmatter `id` format: `SPEC-YYYY-MM-DD-<kebab-topic>` (not `ADR-{serial}-` format)
- Plan frontmatter `id` format: `PLAN-YYYY-MM-DD-<kebab-topic>`
- All changes gated behind `adrEnabled: true` (no separate toggle)
- `specRoot` default: `docs/superpowers/specs` (relative to indexRoot)
- `planRoot` default: `docs/superpowers/plans` (relative to indexRoot)
- Existing ADR files must continue to work unchanged (docType defaults to "adr")
- Anchor index is shared across all doc types (unchanged)
- All new code must have corresponding unit tests

---
### Task 1: Data model — docType in types and Milvus schema

**Files:**
- Modify: `src/plugins/dsh-context-milvus/types.ts`
- Modify: `src/plugins/dsh-context-milvus/milvus-service.ts`
- Test: `test/dsh-context-remdb.spec.ts` (or new test file)

**Interfaces:**
- Consumes: existing `AdrChunk`, `AdrSearchResult`, `AdrFrontmatter` types
- Produces: `AdrChunk.docType`, `AdrSearchResult.docType`, Milvus schema with `doc_type` field

- [ ] **Step 1: Add docType to AdrChunk and AdrSearchResult**

In `src/plugins/dsh-context-milvus/types.ts`:

```typescript
// In AdrChunk interface — add after `adrId: string`
docType: string

// In AdrSearchResult interface — add after `adrId: string`
docType: string
```

- [ ] **Step 2: Add doc_type field to Milvus adr_embeddings schema**

In `src/plugins/dsh-context-milvus/milvus-service.ts`, find the `ensureAdrCollection` method. Add the `doc_type` field to the collection schema:

```typescript
{
  name: 'doc_type',
  dataType: DataType.VarChar,
  maxLength: 32,
  defaultValue: 'adr',
}
```

Handle existing collections: if `describeCollection` succeeds but the `doc_type` field doesn't exist in the returned schema, don't drop the collection — just leave it. The search result mapping provides a default `"adr"` for missing fields.

- [ ] **Step 3: Update AdrChunk insertion to include docType**

In `milvus-service.ts`, find `insertAdrChunks`. Add `doc_type` to the insert data:

```typescript
const insertData = {
  ...existingFields,
  doc_type: chunk.docType || 'adr',  // NEW
  // ...
}
```

- [ ] **Step 4: Update AdrSearchResult mapping to parse docType**

In `milvus-service.ts`, find the ADR search result mapper (the `searchAdr` method). Add `docType` to the mapper output:

```typescript
docType: item.doc_type ?? 'adr',
```

- [ ] **Step 5: Write unit tests**

Add tests in `test/adr-types.spec.ts` (new file):

```typescript
// Test that AdrChunk accepts docType field
// Test that AdrSearchResult accepts docType field
// Test that Milvus schema includes doc_type field with default 'adr'
// Test that search result mapper defaults docType to 'adr' when missing
```

- [ ] **Step 6: Run tests and commit**

```bash
npx jest test/adr-types.spec.ts -v
git add src/plugins/dsh-context-milvus/types.ts src/plugins/dsh-context-milvus/milvus-service.ts test/adr-types.spec.ts
git commit -m "feat(adr): add docType field to AdrChunk, AdrSearchResult, and Milvus schema"
```

---

### Task 2: Config — specRoot and planRoot fields

**Files:**
- Modify: `src/plugins/dsh-context-milvus/config.ts`
- Modify: `src/plugins/dsh-context-milvus/index.ts`
- Test: `test/dsh-context-remdb.spec.ts` (config section)

**Interfaces:**
- Consumes: existing `PluginConfig`, `CordisConfig`
- Produces: `PluginConfig.specRoot`, `PluginConfig.planRoot`, `CordisConfig.specRoot`, `CordisConfig.planRoot`

- [ ] **Step 1: Add fields to CordisConfig and PluginConfig**

In `src/plugins/dsh-context-milvus/config.ts`:

```typescript
// In CordisConfig interface — add after adrSystemPrompt
specRoot?: string
planRoot?: string

// In PluginConfig interface — add after adrSystemPrompt
specRoot: string
planRoot: string
```

- [ ] **Step 2: Set defaults in getConfig()**

In `getConfig()` function, add:

```typescript
specRoot: overrides?.specRoot ?? process.env.SPEC_ROOT ?? 'docs/superpowers/specs',
planRoot: overrides?.planRoot ?? process.env.PLAN_ROOT ?? 'docs/superpowers/plans',
```

- [ ] **Step 3: Add to Config schema in index.ts**

In `src/plugins/dsh-context-milvus/index.ts`, add after `adrSystemPrompt`:

```typescript
/** 规格文档目录 */
specRoot: z.string()
  .default('docs/superpowers/specs')
  .description('Brainstorming 规格文档目录（相对 indexRoot）'),

/** 实现计划目录 */
planRoot: z.string()
  .default('docs/superpowers/plans')
  .description('实现计划文档目录（相对 indexRoot）'),
```

- [ ] **Step 4: Write unit tests**

```typescript
// Test that specRoot defaults to 'docs/superpowers/specs'
// Test that planRoot defaults to 'docs/superpowers/plans'
// Test that env var SPEC_ROOT overrides default
// Test that Cordis config overrides env var
```

- [ ] **Step 5: Run tests and commit**

```bash
npx jest test/config.spec.ts -v
git add src/plugins/dsh-context-milvus/config.ts src/plugins/dsh-context-milvus/index.ts test/config.spec.ts
git commit -m "feat(adr): add specRoot and planRoot config fields"
```

---

### Task 3: Chunker — English section mapping

**Files:**
- Modify: `src/plugins/dsh-context-milvus/adr-chunker.ts`
- Test: `test/adr-chunker.spec.ts`

**Interfaces:**
- Consumes: existing `SECTION_MAP`, `chunkAdrFile` function
- Produces: extended `SECTION_MAP` with English sections; `AdrChunk` entries with `docType` from frontmatter

- [ ] **Step 1: Extend SECTION_MAP with English sections**

```typescript
const SECTION_MAP: Record<string, string> = {
  // ... existing Chinese entries ...
  // English sections (spec/plan common)
  'Context': 'context',
  'Scope': 'scope',
  'Environment findings': 'environment',
  'Architecture decisions': 'decisions',
  'Architecture': 'architecture',
  'Data flow': 'data_flow',
  'Error handling': 'error_handling',
  'Testing': 'testing',
  'Implementation': 'implementation',
  'Migration': 'migration',
  'Deployment': 'deployment',
  'Open questions': 'open_questions',
}
```

- [ ] **Step 2: Pass docType from frontmatter to chunks**

In `chunkAdrFile`, after parsing frontmatter, derive `docType`:

```typescript
const docType = frontmatter.type === 'spec' ? 'spec'
  : frontmatter.type === 'plan' ? 'plan'
  : 'adr'
```

Apply to each chunk:

```typescript
chunks.push({
  filePath,
  adrId: frontmatter.id,
  docType,           // NEW
  section: sectionLabel,
  // ...
})
```

- [ ] **Step 3: Write unit tests**

Create a test spec file content with frontmatter and English sections:

```typescript
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

// Test that chunkAdrFile returns chunks with correct sections
// Test that docType is 'spec' for spec frontmatter
// Test that docType defaults to 'adr' for decision-record frontmatter
// Test that English section names are mapped correctly
// Test that unmatched headings fall through as-is
```

- [ ] **Step 4: Run tests and commit**

```bash
npx jest test/adr-chunker.spec.ts -v
git add src/plugins/dsh-context-milvus/adr-chunker.ts test/adr-chunker.spec.ts
git commit -m "feat(adr): extend chunker SECTION_MAP with English spec/plan sections"
```

---

### Task 4: Indexer — multi-root scanning

**Files:**
- Modify: `src/plugins/dsh-context-milvus/adr-indexer.ts`
- Test: `test/adr-indexer.spec.ts`

**Interfaces:**
- Consumes: `PluginConfig.specRoot`, `PluginConfig.planRoot`, `PluginConfig.adrRoot`
- Produces: `runAdrIndex` scans all three roots; `AdrIndexResult` unchanged

- [ ] **Step 1: Replace ADR_FILE_RE with per-root patterns**

```typescript
const ADR_FILE_RE = /^ADR-\d{4}-.+\.md$/
const SPEC_FILE_RE = /^\d{4}-\d{2}-\d{2}-.+design\.md$/
const PLAN_FILE_RE = /^\d{4}-\d{2}-\d{2}-.+\.md$/
```

The plan regex must NOT match `-design.md` files (they're handled by SPEC_FILE_RE). This is naturally handled because `.md` is the suffix and `-design.md` includes `-design` before `.md`. Since `\d{4}-\d{2}-\d{2}-.+\.md$` matches ANY date-prefixed `.md` file, we need to explicitly exclude the `-design` suffix:

```typescript
const PLAN_FILE_RE = /^\d{4}-\d{2}-\d{2}-(?:(?!.*design\.md$).)+\.md$/
```

- [ ] **Step 2: Refactor runAdrIndex to accept multiple root directories**

Change the function signature to accept an array of scan roots:

```typescript
interface ScanRoot {
  path: string
  fileRe: RegExp
  label: string
}

async function scanDirectory(root: ScanRoot): Promise<Map<string, string>> {
  // ... existing logic from the current adrRoot scan ...
}
```

In `runAdrIndex`, build the scan roots from config:

```typescript
const scanRoots: ScanRoot[] = [
  { path: config.adrRoot, fileRe: ADR_FILE_RE, label: 'ADR' },
  { path: config.specRoot, fileRe: SPEC_FILE_RE, label: 'spec' },
  { path: config.planRoot, fileRe: PLAN_FILE_RE, label: 'plan' },
]
```

- [ ] **Step 3: Handle missing directories gracefully**

Each root directory is optional. If a directory doesn't exist, skip it silently (same as the current behavior when `adrRoot` doesn't exist).

- [ ] **Step 4: Write unit tests**

```typescript
// Test that adrRoot is scanned for ADR-*.md files
// Test that specRoot is scanned for YYYY-MM-DD-*-design.md files
// Test that planRoot is scanned for YYYY-MM-DD-*.md files (excluding -design)
// Test that missing directories are skipped silently
// Test that all roots share the same Merkle tracker
// Test that incremental mode computes delta across all roots
```

- [ ] **Step 5: Run tests and commit**

```bash
npx jest test/adr-indexer.spec.ts -v
git add src/plugins/dsh-context-milvus/adr-indexer.ts test/adr-indexer.spec.ts
git commit -m "feat(adr): multi-root scanning for ADR, spec, and plan directories"
```

---

### Task 5: Anchor generator — code reference detection and frontmatter creation

**Files:**
- Create: `src/plugins/dsh-context-milvus/adr-anchor-generator.ts`
- Test: `test/adr-anchor-generator.spec.ts`

**Interfaces:**
- Consumes: `AdrFrontmatter` type, `parseFrontmatter` from `adr-frontmatter.ts`
- Produces: `generateSpecFrontmatter(specPath, content)` → `GenerateResult`
- Produces: `GenerateResult { adrId, frontmatter, detectedRefs, generated }`

- [ ] **Step 1: Create the anchor generator module**

```typescript
// src/plugins/dsh-context-milvus/adr-anchor-generator.ts

import { readFile, writeFile, rename } from 'node:fs/promises'
import { dump as yamlDump } from 'js-yaml'
import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { parseFrontmatter } from './adr-frontmatter.js'
import type { AdrFrontmatter, AdrCodeAnchor } from './types.js'

export interface DetectedRef {
  file: string
  symbols: string[]
  lines: [number, number]
}

export interface GenerateResult {
  adrId: string
  detectedRefs: DetectedRef[]
  generated: boolean
}

/**
 * Scan a directory for markdown files without YAML frontmatter.
 * Returns absolute file paths that need frontmatter generation.
 */
export async function findCandidateFiles(
  rootDir: string,
  fileRe: RegExp,
): Promise<string[]> {
  // ...
}

/**
 * Detect code references in a spec/plan document.
 * Three strategies (cumulative):
 * 1. @file: and @symbol: annotations
 * 2. src/ lib/ packages/ path patterns
 * 3. Backtick-quoted symbols with nearby file paths
 */
export function detectCodeReferences(
  content: string,
  codebaseRoot: string,
): DetectedRef[] {
  // ...
}

/**
 * Generate YAML frontmatter for a spec/plan document.
 * Returns null if the document already has frontmatter.
 */
export async function generateSpecFrontmatter(
  filePath: string,
  codebaseRoot: string,
): Promise<GenerateResult | null> {
  // ... (see Step 5 for full implementation)
}

/**
 * Preview mode: run detection and build the frontmatter object in memory,
 * but do NOT write to disk. Used by the index_specs tool's dry_run mode.
 */
export async function previewFrontmatter(
  filePath: string,
  codebaseRoot: string,
): Promise<GenerateResult | null> {
  const content = await readFile(filePath, 'utf-8')
  if (parseFrontmatter(content)) return null
  const basename = path.basename(filePath)
  const isSpec = /design\.md$/.test(basename)
  const docType = isSpec ? 'spec' : 'plan'
  const now = new Date().toISOString().slice(0, 10)
  const topic = basename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')
  const adrId = `${docType === 'spec' ? 'SPEC' : 'PLAN'}-${now}-${topic}`
  const detectedRefs = detectCodeReferences(content, codebaseRoot)
  return { adrId, detectedRefs, generated: false }
}
```

- [ ] **Step 2: Implement @file annotation detection**

```typescript
const FILE_ANNOTATION_RE = /@file:([^\s\n]+(?:\.[a-z]+)?)/g
const SYMBOL_ANNOTATION_RE = /@symbol:([^\s\n]+)/g
```

Parse these annotations from the content. Files are resolved relative to the codebase root. Validate that the file exists.

- [ ] **Step 3: Implement path pattern matching**

```typescript
// Common source directory prefixes
const PATH_PREFIXES = ['src/', 'lib/', 'packages/', 'app/', 'include/', 'test/']
// Match alphanumeric/extended path characters
const PATH_RE = /(?<=^|\s|["'`(])(src|lib|packages|app|include|test)\/[^\s:;,)]+(?:\.[a-z]+)?/g
```

Scan the content for path-like strings, validate they exist on disk, and record them.

- [ ] **Step 4: Implement symbol reference detection**

```typescript
// Backtick-quoted identifiers (function/class names)
const SYMBOL_RE = /`([a-zA-Z_$][a-zA-Z0-9_$]*)`/g
```

For each symbol, look backward in the text for the nearest applicable file path. If found, associate the symbol with that file.

- [ ] **Step 5: Implement frontmatter construction and atomic write**

```typescript
export async function generateSpecFrontmatter(
  filePath: string,
  codebaseRoot: string,
): Promise<GenerateResult | null> {
  const content = await readFile(filePath, 'utf-8')

  // Skip if already has frontmatter
  if (parseFrontmatter(content)) return null

  // Detect type from filename
  const basename = path.basename(filePath)
  const isSpec = /design\.md$/.test(basename)
  const docType = isSpec ? 'spec' : 'plan'

  // Detect code references
  const detectedRefs = detectCodeReferences(content, codebaseRoot)

  // Build frontmatter object
  const now = new Date().toISOString().slice(0, 10)
  const topic = basename.replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')
  const adrId = `${docType === 'spec' ? 'SPEC' : 'PLAN'}-${now}-${topic}`

  const frontmatter: AdrFrontmatter = {
    id: adrId,
    type: docType,
    status: 'active',
    created: now,
    updated: now,
    author: 'dsh-context-milvus',
    supersedes: null,
    superseded_by: null,
    code_anchors: detectedRefs.map(ref => ({
      file: ref.file,
      symbols: ref.symbols,
      lines: ref.lines,
      git_commit: '',
    })),
    trigger: {
      task_id: null,
      requirement_summary: topic.replace(/-/g, ' '),
      change_type: 'architecture',
    },
    related_decisions: [],
    auto_generated: true,
  }

  // Serialize with js-yaml (key order preserved, no refs)
  const yaml = yamlDump(frontmatter, { lineWidth: 120, noRefs: true, sortKeys: false })
  const newContent = `---\n${yaml}---\n\n${content}`

  // Atomic write via temp file + rename (same pattern as adr-service.ts)
  const tmpPath = `${filePath}.tmp`
  await writeFile(tmpPath, newContent, 'utf-8')
  await rename(tmpPath, filePath)

  return { adrId, detectedRefs, generated: true }
}
```

- [ ] **Step 6: Write unit tests**

```typescript
// Test @file annotation detection
// Test @symbol annotation detection
// Test path pattern matching
// Test symbol back-reference detection
// Test frontmatter generation (adrId, type, code_anchors)
// Test that files with existing frontmatter are skipped
// Test dry_run mode (no file write)
```

- [ ] **Step 7: Run tests and commit**

```bash
npx jest test/adr-anchor-generator.spec.ts -v
git add src/plugins/dsh-context-milvus/adr-anchor-generator.ts test/adr-anchor-generator.spec.ts
git commit -m "feat(adr): add anchor generator for spec/plan code reference detection"
```

---

### Task 6: Tools — index_specs and search_adr enhancement

**Files:**
- Modify: `src/plugins/dsh-context-milvus/adr-tools.ts`
- Test: `test/adr-tools.spec.ts`

**Interfaces:**
- Consumes: `adr-anchor-generator.ts` functions, `runAdrIndex`, `HashTracker`, `searchAdr`
- Produces: `index_specs` tool registration; `search_adr` render includes docType

- [ ] **Step 1: Register index_specs tool**

In `registerAdrTools`, add a new tool:

```typescript
ctx.tools.register(defineTool({
  name: 'index_specs',
  description: '扫描规格文档目录，为无 frontmatter 的文档生成锚点并索引。',
  parameters: {
    path: { type: 'string', description: '指定扫描路径（默认扫描所有 specs 和 plans）' },
    dry_run: { type: 'boolean', description: '仅预览将生成的锚点，不写入文件' },
  },
  output: {
    schema: {
      type: 'object', properties: {
        filesProcessed: { type: 'number' },
        anchorsGenerated: { type: 'number' },
        filesIndexed: { type: 'number' },
        chunksIndexed: { type: 'number' },
        dryRun: { type: 'boolean' },
        preview: { type: 'array', items: { type: 'object', properties: {
          filePath: { type: 'string' },
          adrId: { type: 'string' },
          detectedRefs: { type: 'array', items: { type: 'object', properties: {
            file: { type: 'string' }, symbols: { type: 'array', items: { type: 'string' } },
          } } },
        } } },
      }, additionalProperties: false,
    },
    render: /* format the result */,
  },
  async execute(params: any, exec?: any) {
    // Resolve roots against the session workspace (same pattern as
    // resolveEffectiveAdrRoot in this file)
    const config = resolveConfig()
    const sessionCwd = exec?.agent?.session?.header?.cwd as string | undefined
    const indexRoot = sessionCwd || config.indexRoot || process.cwd()
    const specRoot = params.path
      ? params.path
      : path.resolve(indexRoot, config.specRoot || 'docs/superpowers/specs')
    const planRoot = params.path
      ? ''
      : path.resolve(indexRoot, config.planRoot || 'docs/superpowers/plans')

    // 1. Find candidate files (no frontmatter) in specRoot + planRoot
    const candidates: string[] = []
    if (specRoot) candidates.push(...await findCandidateFiles(specRoot, /^\d{4}-\d{2}-\d{2}-.+design\.md$/))
    if (planRoot) candidates.push(...await findCandidateFiles(planRoot, /^\d{4}-\d{2}-\d{2}-(?:(?!.*design\.md$).)+\.md$/))

    // 2. For each: generate frontmatter (dry_run = preview only)
    const preview: any[] = []
    let anchorsGenerated = 0
    for (const filePath of candidates) {
      const result = params.dry_run
        ? await previewFrontmatter(filePath, indexRoot)
        : await generateSpecFrontmatter(filePath, indexRoot)
      if (result) {
        preview.push({ filePath, adrId: result.adrId, detectedRefs: result.detectedRefs })
        anchorsGenerated += result.detectedRefs.length
      }
    }

    // 3. If not dry_run: run runAdrIndex to index the new files
    let filesIndexed = 0
    let chunksIndexed = 0
    if (!params.dry_run && candidates.length > 0) {
      const adrConfig = {
        ...config,
        adrRoot: path.resolve(indexRoot, config.adrRoot || 'docs/decisions'),
        specRoot,
        planRoot,
      }
      const result = await adrIndexer.runAdrIndex(
        adrConfig, milvus, adrIndexer.tracker, anchorIndex, { mode: 'incremental' },
      )
      filesIndexed = result.filesIndexed
      chunksIndexed = result.chunksIndexed
    }

    return {
      filesProcessed: candidates.length,
      anchorsGenerated,
      filesIndexed,
      chunksIndexed,
      dryRun: !!params.dry_run,
      preview,
    }
  },
}))
```

- [ ] **Step 2: Enhance search_adr render to show docType**

Update `formatAdrSearchResults`:

```typescript
function formatAdrSearchResults(value: any[]): string {
  if (value.length === 0) return '未找到匹配的 ADR 决策记录。'
  return value.map((item: any, i: number) => {
    const typeLabel = item.docType === 'spec' ? ', spec' : item.docType === 'plan' ? ', plan' : ''
    return [
      `[结果 ${i + 1}] ADR: ${item.adrId} (${item.status}${typeLabel}), 章节: ${item.section}`,
      // ... rest unchanged
    ].join('\n')
  }).join('\n---\n')
}
```

- [ ] **Step 3: Write unit tests**

```typescript
// Test index_specs tool registration
// Test index_specs dry_run returns preview (no file write)
// Test index_specs writes frontmatter and indexes
// Test search_adr render includes docType label
// Test search_adr results include docType field
```

- [ ] **Step 4: Run tests and commit**

```bash
npx jest test/adr-tools.spec.ts -v
git add src/plugins/dsh-context-milvus/adr-tools.ts test/adr-tools.spec.ts
git commit -m "feat(adr): add index_specs tool and enhance search_adr with docType"
```

---

### Task 7: Tools — index_code auto-scan + constraint-injector spec-write hint

**Files:**
- Modify: `src/plugins/dsh-context-milvus/tools.ts`
- Modify: `src/plugins/dsh-context-milvus/constraint-injector.ts`
- Test: `test/adr-tools.spec.ts`, `test/constraint-injector.spec.ts`

**Interfaces:**
- Consumes: `PluginConfig.specRoot`, `PluginConfig.planRoot`, `runAdrIndex`
- Produces: `index_code` auto-scans specs/plans; `tools/result` hook warns on spec/plan writes

- [ ] **Step 1: index_code auto-scan specs/plans**

In `tools.ts`, in the `index_code` tool's `execute` handler, after the ADR indexing block:

```typescript
// After ADR indexing (or during it — adr-indexer now handles multi-root)
// The runAdrIndex already scans all roots when config.adrEnabled is true
// No additional change needed here — Task 4 already handles it
```

Actually, verify: `tools.ts` line 251-263 calls `runAdrIndex` with `adrConfig` which overrides `adrRoot`. We need to also pass `specRoot` and `planRoot`:

```typescript
const adrConfig = {
  ...effectiveConfig,
  adrRoot: path.resolve(effectiveConfig.indexRoot, effectiveConfig.adrRoot),
  specRoot: path.resolve(effectiveConfig.indexRoot, effectiveConfig.specRoot),  // NEW
  planRoot: path.resolve(effectiveConfig.indexRoot, effectiveConfig.planRoot),  // NEW
}
```

- [ ] **Step 2: Add spec/plan write detection to constraint-injector**

In `constraint-injector.ts`, extend the `tools/result` hook to detect writes to spec/plan directories:

```typescript
// After the existing ADR anchor check, add:
const specRoot = resolveConfig().specRoot
const planRoot = resolveConfig().planRoot
if (specRoot && filePath.startsWith(specRoot)) {
  state.pendingWarnings.push(
    `📄 检测到新的规格文档 ${filePath}。建议调用 \`index_specs\` 为其生成 code_anchors 并索引入库。`,
  )
}
if (planRoot && filePath.startsWith(planRoot)) {
  // Similar warning for plan files
}
```

- [ ] **Step 3: Write unit tests**

```typescript
// Test that index_code passes specRoot/planRoot to adr-indexer
// Test that tools/result hook detects spec path writes
// Test that tools/result hook detects plan path writes
// Test that tools/result hook does NOT warn for non-spec/plan paths
```

- [ ] **Step 4: Run tests and commit**

```bash
npx jest test/adr-tools.spec.ts test/constraint-injector.spec.ts -v
git add src/plugins/dsh-context-milvus/tools.ts src/plugins/dsh-context-milvus/constraint-injector.ts test/
git commit -m "feat(adr): index_code auto-scan specs/plans and spec-write hint in constraint-injector"
```

---

### Task 8: Documentation

**Files:**
- Modify: `README.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: none (documentation only)
- Produces: updated README and AGENTS.md with spec-fusion workflow

- [ ] **Step 1: Update README.md**

Add a section about spec/plan document fusion:

```markdown
## 规格文档融合（Spec Document Fusion）

当 brainstorming 技能产出规格文档后，可以通过以下步骤将其与代码库建立链接：

1. **编写规格文档**：brainstorming 输出保存到 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
2. **生成锚点**：调用 `index_specs` 工具，自动检测文档中的代码引用并生成 frontmatter + code_anchors
3. **索引入库**：`index_code` 会自动扫描 `docs/superpowers/specs/` 和 `docs/superpowers/plans/` 目录
4. **搜索发现**：`search_adr` 工具会统一返回 ADR 和规格文档的搜索结果（带 `docType` 标注）

### 配置项

| 配置项 | 默认值 | 说明 |
|--------|--------|------|
| `specRoot` | `docs/superpowers/specs` | 规格文档目录（相对 indexRoot） |
| `planRoot` | `docs/superpowers/plans` | 实现计划目录（相对 indexRoot） |

规格文档融合跟随 `adrEnabled` 开关，无需额外配置。
```

- [ ] **Step 2: Update AGENTS.md**

Add `index_specs` to the available tools table:

```markdown
| `index_specs` | 扫描规格文档目录，为无 frontmatter 的文档生成锚点并索引 | `path`、`dry_run` |
```

Add usage rule:

```markdown
6. **Brainstorming 产出后调用 index_specs**

   当 brainstorming 技能完成规格文档写作后，调用 `index_specs` 为其生成 code_anchors 并索引入库，让规格与代码建立双向链接。
```

- [ ] **Step 3: Commit**

```bash
git add README.md AGENTS.md
git commit -m "docs: add spec-document-fusion workflow to README and AGENTS.md"
```