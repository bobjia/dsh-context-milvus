---
id: SPEC-2026-09-04-decision-causal-memory-design
type: spec
status: active
created: '2026-09-04'
updated: '2026-09-04'
author: dsh-context-milvus
supersedes: null
superseded_by: null
code_anchors:
  - file: /mnt/home/bobjia/workspace/dsh-context-milvus/src/plugins/dsh-context-milvus
    symbols:
      - adr_embeddings
      - code_embeddings
      - id
      - vector
      - sparse_vector
      - adr_id
      - file_path
      - status
      - active
      - superseded
      - deprecated
      - section
      - content
      - start_line
      - end_line
      - code_anchors
      - trigger_type
      - new_feature
      - refactor
      - bugfix
      - header
      - goal
      - constraints
      - alternatives
      - hidden_constraints
      - rejected
      - tests
      - boundary
      - search_adr_by_file
      - adrConstraintReinjectEvery
      - search_adr
      - create_adr
      - update_adr
      - list_adrs
      - load_constraints
      - check_adr_consistency
      - adrEnabled
      - ADR_ENABLED
      - 'true'
      - adrRoot
      - ADR_ROOT
      - adrCollection
      - ADR_COLLECTION
      - ADR_REINJECT_EVERY
      - adrSystemPrompt
      - ADR_SYSTEM_PROMPT
      - registerTools
    lines:
      - 51
      - 302
    git_commit: ''
trigger:
  task_id: null
  requirement_summary: decision causal memory design
  change_type: architecture
related_decisions: []
auto_generated: true
---

# Decision Causal Memory System — Design

Date: 2026-09-01
Status: Approved (approach + design sections confirmed by user)

## Context

`dsh-context-milvus` currently provides semantic code search via Milvus with three
tools (`search_code`, `index_code`, `index_status`). It indexes code into a Milvus
vector database and searches it via natural language queries with BM25 hybrid fusion.

The user wants to extend this plugin to implement the **Decision Causal Memory System**
spec — a system that captures and recalls the WHY behind code decisions, preventing
AI coding agents from forgetting design motivations across sessions.

## Scope

**Full core** (selected by user): ADR indexing/search/CRUD + code_anchors deterministic
cross-reference + constraint re-injection (pre-step hook) + system prompt injection +
consistency check tools.

## Environment findings

DSH framework version: `0.1.1-rc.2` (at `@deepseek-ai/dsh`).

Key DSH framework APIs confirmed available:

| Package | API | Purpose |
|---------|-----|---------|
| `@deepseek-ai/dsh-system-prompt` | `ctx.systemPrompt.section()` | Register ordered system prompt sections |
| `@deepseek-ai/dsh-system-prompt` | `ctx.systemPrompt.context()` | Register dynamic runtime context (text provider per step) |
| `@deepseek-ai/dsh-system-prompt` | `ctx.systemPrompt.variable()` | Register `{{variable}}` interpolation |
| `@deepseek-ai/dsh-agent-instructions` | (built-in) | Auto-loads AGENTS.md / CLAUDE.md — Layer 1 already handled |
| `@deepseek-ai/dsh-schedule` | Durable at/after/rate | Periodic constraint re-injection (optional) |
| Cordis lifecycle | `ctx.on("agent/pre-step")` | Pre-step hook for constraint injection |
| Cordis lifecycle | `ctx.on("tools/result")` | Post-tool hook for file-change tracking |
| Cordis lifecycle | `ctx.on("session/event")` | Session lifecycle events |

**Key finding: ~85% of the spec is feasible within the plugin.** The remaining ~15%
(AgentDiff git-notes, CI integration, test runner) are deployment-environment concerns
outside the plugin boundary.

## Architecture decisions

### Decision 1: Incremental extension (not unified collection, not split plugin)

Keep the existing code search infrastructure intact. Add decision memory as new
independent modules:

```
src/plugins/dsh-context-milvus/
├── index.ts                 # Entry (extended: init ADR + register tools + inject prompt + lifecycle hooks)
├── config.ts                # Extended: new ADR config fields
├── types.ts                 # Extended: ADR-specific types
├── tools.ts                 # Existing (minor: registerTools signature extended with ADR options)
├── adr-tools.ts             # New: 7 ADR tools
├── adr-service.ts           # New: ADR CRUD + auto-numbering + state management
├── adr-indexer.ts           # New: ADR indexing pipeline
├── adr-chunker.ts           # New: markdown section-based chunker
├── adr-frontmatter.ts       # New: YAML frontmatter parser
├── adr-anchor-index.ts      # New: code_anchors reverse index (JSON sidecar)
├── constraint-injector.ts   # New: system prompt injection + constraint re-injection + file-change tracking
├── milvus-service.ts        # Existing (extended for multi-collection)
├── merkle.ts                # Existing (reused)
├── embedding.ts             # Existing (reused)
├── chunker.ts               # Existing (unchanged)
└── ignore-matcher.ts        # Existing (reused)
```

Rationale: backward compatible, modular, independent testing, progressive release.

### Decision 2: Separate Milvus collection for ADRs

New collection `adr_embeddings`, separate from the existing `code_embeddings`.
Schema optimized for ADR semantics:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | Int64 (PK, autoID) | Primary key |
| `vector` | FloatVector(dim) | Dense embedding (reuse existing embedding API) |
| `sparse_vector` | SparseFloatVector | BM25 sparse field (hybrid mode) |
| `adr_id` | VarChar(256) | e.g. `ADR-0001-decision-memory-system` |
| `file_path` | VarChar(1024) | ADR file path |
| `status` | VarChar(32) | `active` \| `superseded` \| `deprecated` |
| `section` | VarChar(64) | ADR section label (see chunking) |
| `content` | VarChar(65535) | Section text (with BM25 analyzer) |
| `start_line` / `end_line` | Int32 | Source location |
| `code_anchors` | VarChar(1024) | JSON array of anchored file paths |
| `trigger_type` | VarChar(64) | `new_feature` \| `refactor` \| `bugfix` \| ... |

Reuses the same hybrid search pattern (BM25 + dense vector + RRF) as the code
collection. Graceful degradation to dense-only when the server doesn't support BM25
functions.

### Decision 3: Markdown section-based chunking (not tree-sitter)

ADR files are markdown documents, not code. Split by `##` heading level:

| `section` value | Heading | Retrieval use |
|----------------|---------|---------------|
| `header` | Frontmatter (metadata only, not vectorized) | Status filter, anchor lookup |
| `goal` | `## 决策目标` | "Why" search |
| `constraints` | `## 约束条件` | Constraint retrieval |
| `alternatives` | `## 候选方案与权衡` | Rejected alternatives |
| `hidden_constraints` | `## 关键设计细节与隐性约束` | Hidden constraints, pitfalls |
| `rejected` | `## 被否决的模式/反模式` | Anti-patterns |
| `tests` | `## 相关测试` | Test associations |
| `boundary` | `## 变更边界` | Decision lifecycle |

Frontmatter is parsed structurally (not vectorized), used for filtering and
anchor indexing.

### Decision 4: code_anchors reverse index as JSON sidecar

For O(1) deterministic cross-reference: `file_path → [ADR ids]`.

- Stored in `~/.milvus-index/anchors-<workspace-hash>.json`
- Rebuilt during ADR indexing
- Used by `search_adr_by_file` tool and `tools/result` file-change hooks
- Provides fast, offline-capable anchor lookup without hitting Milvus

### Decision 5: Three-layer prompt integration

| Layer | API | Frequency | Content | Purpose |
|-------|-----|-----------|---------|---------|
| Static rules | `ctx.systemPrompt.section()` | Every step | ADR compliance rules (spec Appendix B) | Agent knows "must follow ADR rules" |
| Dynamic context | `ctx.systemPrompt.context()` | Every step | Active ADR constraint summary | Agent always aware of current constraints |
| Step reminder | `agent/pre-step` hook | Every N steps + on file change | Re-injection reminder + consistency warning | Prevents constraint decay |

### Decision 6: Step-based constraint re-injection

Every `adrConstraintReinjectEvery` steps (default 5), a pre-step hook injects a
user-role message with the current active ADR constraints summary. Uses the
`agent/pre-step` event to modify the message list before the agent's next inference.

File changes detected via `tools/result` hook (same pattern as `dsh-agent-instructions`
uses for file-touch tracking).

## Tools specification

Seven new tools, all registered via `defineTool()` from `@deepseek-ai/dsh-tools`:

### `search_adr` — Semantic decision memory search

```
parameters:
  query:  string (required) — natural language query
  path:   string (optional) — limit ADR directory scope (passed as pathPrefix filter to Milvus)
  status: string (optional) — "active" | "superseded" | "deprecated" | "all" (default "all")
  topK:   number (optional) — default 5

output: array of { adrId, filePath, status, section, content, score, triggerType, ... }
search: BM25 + vector hybrid + RRF
```

### `search_adr_by_file` — Deterministic anchor lookup

```
parameters:
  file_path: string (required) — code file path (absolute or relative)
  status:    string (optional) — ADR status filter

output: array of ADRs with full summary + anchor match details
implementation: O(1) lookup via adr-anchor-index.json
```

### `create_adr` — Create new ADR

```
parameters:
  title:       string (required) — kebab-case description
  requirement: string (optional) — trigger requirement summary
  change_type: string (optional) — new_feature | refactor | bugfix | optimization | architecture
  supersedes:  string (optional) — superseded ADR id
  content:     string (optional) — custom body (default: template-generated)

behavior:
  1. Auto-number (scan docs/decisions/ for max serial + 1)
  2. Generate ADR file from template (spec section 3.2)
  3. Write to docs/decisions/ADR-{serial}-{title}.md
  4. Auto-index to Milvus + update anchor index
```

### `update_adr` — Update existing ADR

```
parameters:
  adr_id:       string (required) — ADR-{serial} or ADR-{serial}-{description}
  content:      string (optional) — replace body
  status:       string (optional) — change status
  superseded_by: string (optional) — mark superseded by
  merge:        boolean (optional) — merge content (preserve unspecified fields)

behavior:
  1. Find file by adr_id
  2. Update frontmatter (auto-refresh updated timestamp)
  3. Rewrite body
  4. Re-index to Milvus + rebuild anchor index
```

### `list_adrs` — List ADR directory

```
parameters:
  status:      string (optional) — "active" | "superseded" | "deprecated" | "all" (default "active")
  change_type: string (optional) — filter by trigger type
  limit:       number (optional) — default 100

output: array of { adr_id, title, status, created, anchor_count, summary }
```

### `load_constraints` — Load active constraints

```
parameters:
  adr_ids: string[] (optional) — specific ADRs (default: all active)
  format:  string (optional) — "summary" | "full" (default "summary")

output: structured constraints with hidden constraints, rejected patterns, source ADR id
```

### `check_adr_consistency` — Consistency check

```
parameters:
  file_path: string (optional) — specific file (default: all code_anchors)
  fix:       boolean (optional) — auto-fix (e.g. remove dead anchors)

output:
  - staleAnchors: files no longer exist / moved
  - uncoveredChanges: modified files covered by code_anchors but ADR not updated
  - outdatedStatus: change-boundary conditions triggered but ADR not superseded/deprecated
```

## Configuration

New configuration fields (all optional, with defaults):

| Field | Env var | Default | Description |
|-------|---------|---------|-------------|
| `adrEnabled` | `ADR_ENABLED` | `true` | Master switch |
| `adrRoot` | `ADR_ROOT` | `docs/decisions` | ADR directory (relative to indexRoot) |
| `adrCollection` | `ADR_COLLECTION` | `adr_embeddings` | Milvus collection name |
| `adrConstraintReinjectEvery` | `ADR_REINJECT_EVERY` | `5` | Steps between constraint re-injection (0=disable) |
| `adrSystemPrompt` | `ADR_SYSTEM_PROMPT` | Built-in template | Custom system prompt section (empty=disable) |

## Lifecycle event flow (complete scenario)

```
1. User: "add a webhook retry queue"
2. Agent step → pre-step hook:
   - ADR rules in system prompt (section())
   - Active constraint summary in context (context())
3. Agent calls search_code → finds relevant code
4. Agent calls search_adr_by_file → finds related ADRs (or none, for new feature)
5. Agent calls create_adr → creates ADR-0004 for the new feature
6. Agent edits code → tools/result hook:
   - Detects file change
   - Checks anchor index → file not covered by any ADR (new feature, OK)
7. Agent edits a file covered by ADR-0001 → tools/result hook:
   - File change → anchor index hit → adds to pending-reminder queue
8. Next step → pre-step hook:
   - Injects reminder: "⚠️ You modified file X, covered by ADR-0001 code_anchors"
9. Agent calls update_adr → updates ADR-0001 code_anchors
10. Before task completion, Agent runs check_adr_consistency
11. No issues found → task complete
```

## Out of scope (deployment environment)

These components are explicitly outside the plugin boundary and should be addressed
in the deployment checklist (spec section 10):

- AgentDiff git-notes (Git hooks, external tool)
- CI ADR consistency check (CI pipeline, external)
- Test suite runner (CI pipeline, external)

The AGENTS.md file should document these as external prerequisites.

## Changes summary

### New files (7)

| File | Lines (est.) | Purpose |
|------|-------------|---------|
| `adr-tools.ts` | ~300 | 7 DSH tool definitions + render functions |
| `adr-service.ts` | ~200 | ADR CRUD, auto-numbering, state management |
| `adr-indexer.ts` | ~150 | ADR indexing pipeline (walk → parse → chunk → embed → insert) |
| `adr-chunker.ts` | ~100 | Markdown section-based chunker |
| `adr-frontmatter.ts` | ~80 | YAML frontmatter parser |
| `adr-anchor-index.ts` | ~80 | code_anchors reverse index (JSON sidecar) |
| `constraint-injector.ts` | ~150 | System prompt injection + constraint re-injection + file-change hooks |

### Modified files (5)

| File | Changes |
|------|---------|
| `index.ts` | Init ADR services, register ADR tools, call constraint-injector setup |
| `config.ts` | Add ADR config fields + env var mappings |
| `types.ts` | Add ADR-specific types (AdrChunk, AdrSearchResult, AdrIndexStatus, etc.) |
| `tools.ts` | Extend `registerTools` signature to accept optional ADR indexer options |
| `milvus-service.ts` | Add `adrCollection` parameter, `ensureAdrCollection()`, `insertAdrChunks()`, `searchAdr()` |