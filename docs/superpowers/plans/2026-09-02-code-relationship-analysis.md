---
title: code-relationship-analysis
type: plan
created: 2026-09-02
status: draft
id: PLAN-2026-09-02-code-relationship-analysis
---

# Code Relationship Analysis Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add code relationship analysis — find_callers (impact analysis) and trace_call_chain (BFS call chain) — to the dsh-context-milvus plugin.

**Architecture:** Extend `code_embeddings` with `references` JSON field (dynamic, one per chunk). New `code-relations.ts` module provides BFS engine and denoising. Two new DSH tools: `find_callers` and `trace_call_chain`. Milvus `query()` with `json_contains` expression filter for reference lookup.

**Tech Stack:** TypeScript, tree-sitter, Milvus 2.x (expression filter), @deepseek-ai/dsh-tools (defineTool)

## Global Constraints

- `references` stored as JSON array via `enable_dynamic_field: true` — no schema migration
- V1 only: no cross-file import resolution (name-based matching via json_contains)
- Valid only for tree-sitter languages; regex-fallback (PHP) → empty references
- BFS visited set prevents cycles; maxDepth defaults to 3
- ~15 new symbols per chunk stored; deduped per chunk via Set
- Backward compat: old chunks without `references` field return empty results
- No new dependencies; all tree-sitter grammars already installed
- Test invocation: `node --experimental-vm-modules node_modules/.bin/jest`

---

### Task 1: types.ts — Add references to CodeChunk and referenceNodeTypes to LanguageConfig

**Files:**
- Modify: `src/plugins/dsh-context-milvus/types.ts`
- Test: `test/code-relations.spec.ts` (new, created in Task 6)

**Interfaces:**
- Consumes: nothing new
- Produces: `CodeChunk.references?: string[]`, `LanguageConfig.referenceNodeTypes?: string[]`

- [ ] **Step 1: Add `references` to CodeChunk**

```typescript
/** 代码块（从 AST 中提取的语义单元） */
export interface CodeChunk {
  filePath: string
  content: string
  startLine: number
  endLine: number
  language: string
  chunkType: string   // e.g. 'function', 'class', 'method', 'interface'
  name: string        // e.g. function name, class name
  references?: string[]  // NEW: symbols referenced by this chunk
}
```

- [ ] **Step 2: Add `referenceNodeTypes` to LanguageConfig**

```typescript
export interface LanguageConfig {
  name: string
  extensions: string[]
  chunkNodeTypes: string[]
  referenceNodeTypes?: string[]  // NEW: AST node types to collect as references
}
```

- [ ] **Step 3: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 4: Commit**

```bash
git add src/plugins/dsh-context-milvus/types.ts
git commit -m "feat(relations): add references and referenceNodeTypes to type definitions"
```

---

### Task 2: chunker.ts — Reference extraction from AST

**Files:**
- Modify: `src/plugins/dsh-context-milvus/chunker.ts`
- Test: `test/code-relations.spec.ts` (new, created in Task 6)

**Interfaces:**
- Consumes: `LanguageConfig.referenceNodeTypes` (Task 1), `CodeChunk.references` (Task 1)
- Produces: `extractReferences(node, ownName, refTypes): string[]` — extracts symbols from a chunk's AST node

- [ ] **Step 1: Add per-language `referenceNodeTypes` to each language definition**

For each language that has a tree-sitter parser, add `referenceNodeTypes`:

```typescript
// TypeScript
config: {
  name: 'typescript',
  extensions: ['.ts', '.tsx', '.mts', '.cts'],
  chunkNodeTypes: ['function_declaration', 'method_definition', ...],
  referenceNodeTypes: [  // NEW
    'call_expression',
    'import_statement',
    'import_specifier',
    'member_expression',
    'identifier',
  ],
},

// JavaScript
referenceNodeTypes: ['call_expression', 'import_statement', 'import_specifier', 'member_expression', 'identifier'],

// Python
referenceNodeTypes: ['call', 'import_statement', 'import_from_statement', 'attribute', 'identifier'],

// Rust
referenceNodeTypes: ['call_expression', 'use_declaration', 'scoped_use_list', 'field_expression', 'identifier'],

// Go
referenceNodeTypes: ['call_expression', 'import_declaration', 'selector_expression', 'identifier'],

// Java
referenceNodeTypes: ['method_invocation', 'import_declaration', 'field_access', 'identifier'],

// C++ / C#
referenceNodeTypes: ['call_expression', 'using_directive', 'field_expression', 'identifier'],

// Scala
referenceNodeTypes: ['apply_expression', 'import', 'select_expression', 'identifier'],

// PHP (regex fallback) — no referenceNodeTypes, skip extraction
```

- [ ] **Step 2: Add `extractReferences` function near `extractNodeName`**

```typescript
/** Language keywords to exclude from references */
const LANGUAGE_KEYWORDS = new Set([
  'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'async', 'await',
  'yield', 'new', 'typeof', 'instanceof', 'void', 'delete', 'import', 'export',
  'default', 'from', 'as', 'in', 'of', 'this', 'super', 'class', 'function',
  'interface', 'enum', 'type', 'extends', 'implements', 'static', 'public',
  'private', 'protected', 'abstract', 'readonly', 'declare', 'module', 'namespace',
  'require', 'true', 'false', 'null', 'undefined', 'any', 'string', 'number',
  'boolean', 'void', 'never', 'unknown', 'bigint', 'symbol',
])

/** Symbols too generic to be useful as references */
const COMMON_WORDS = new Set([
  'data', 'config', 'result', 'process', 'error', 'value', 'item', 'args',
  'options', 'tmp', 'temp', 'key', 'val', 'name', 'type', 'size', 'length',
  'index', 'count', 'total', 'status', 'msg', 'err', 'str', 'num', 'obj',
  'arr', 'fn', 'cb', 'done', 'next', 'promise', 'callback', 'resolve',
  'reject', 'then', 'catch', 'finally', 'map', 'filter', 'reduce', 'forEach',
  'some', 'every', 'find', 'flat', 'flatMap', 'sort', 'reverse', 'includes',
])

/** Extract referenced symbols from a chunk's AST node */
function extractReferences(node: any, ownName: string, refTypes: Set<string>): string[] {
  const refs = new Set<string>()

  function walk(n: any) {
    if (!n || !n.type) return
    if (refTypes.has(n.type)) {
      const symbol = extractSymbolFromNode(n)
      if (symbol && symbol.length > 1 && !LANGUAGE_KEYWORDS.has(symbol) && !COMMON_WORDS.has(symbol) && symbol !== ownName) {
        refs.add(symbol)
      }
    }
    if (n.childCount > 0) {
      for (const child of n.children) {
        walk(child)
      }
    }
  }

  walk(node)
  return Array.from(refs)
}

/** Extract the symbol name from a reference node */
function extractSymbolFromNode(node: any): string | null {
  switch (node.type) {
    case 'call_expression': {
      // For a call like parseConfig(args), the function child has the name
      const fnNode = node.childForFieldName('function')
      return fnNode ? fnNode.text : null
    }
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
      return node.text
    case 'member_expression':
    case 'field_expression':
    case 'select_expression':
    case 'attribute':
      return node.text  // e.g. "this.foo", "svc.start"
    case 'import_statement':
    case 'import_declaration':
    case 'import':
    case 'import_from_statement':
      // For import { X } from ..., collect imported identifiers
      // We collect the binding names, not module paths
      return null  // handled by child identifiers
    case 'import_specifier':
      // The imported name itself
      return node.childForFieldName('name')?.text ?? null
    case 'method_invocation':
      // Java: obj.method() → the method name
      return node.childForFieldName('name')?.text ?? null
    case 'apply_expression':
      // Scala: function(args) → the function node
      return node.childForFieldName('function')?.text ?? null
    default:
      return null
  }
}
```

- [ ] **Step 3: Integrate extraction into `chunkWithTreeSitter`**

After the existing `.map()` in `chunkWithTreeSitter` (line 286-294), add `references` to the returned chunk:

```typescript
    .map((node: any) => {
      const ownName = extractNodeName(node)
      const refTypes = def.config.referenceNodeTypes
      const refSet = refTypes ? new Set(refTypes) : new Set()
      return {
        filePath,
        content: node.text,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        language: def.config.name,
        chunkType: node.type,
        name: ownName,
        references: extractReferences(node, ownName, refSet),
      }
    })
```

- [ ] **Step 4: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/chunker.ts
git commit -m "feat(relations): extract references from AST chunks"
```

---

### Task 3: milvus-service.ts — queryByReference and queryByName methods

**Files:**
- Modify: `src/plugins/dsh-context-milvus/milvus-service.ts`
- Modify: `src/plugins/dsh-context-milvus/indexer.ts` (insert `references` in insert mapping)
- Test: `test/code-relations.spec.ts` (new, created in Task 6)

**Interfaces:**
- Consumes: `CodeChunk.references` (Task 1)
- Produces: `queryByReference(symbol, limit): Promise<SearchResult[]>` — find chunks referencing a symbol
- Produces: `queryByName(name, limit): Promise<SearchResult[]>` — find chunks by exact name

- [ ] **Step 1: Add `queryByReference` method**

```typescript
/**
 * Find code chunks that reference a given symbol.
 * Uses Milvus query() with json_contains expression filter.
 */
async queryByReference(symbol: string, limit: number = 20, pathPrefix?: string): Promise<SearchResult[]> {
  const client = this.getClient()
  const { collection } = this

  const filter = `json_contains(references, "${symbol}")`
  const expr = pathPrefix ? `file_path like "${pathPrefix}%" and ${filter}` : filter

  const response = await client.query({
    collection_name: collection,
    expr,
    output_fields: ['file_path', 'code_content', 'start_line', 'end_line', 'language', 'chunk_type', 'name', 'references'],
    limit,
  } as any)

  const items = (response.data ?? []) as any[]
  return items.map((item: any) => ({
    filePath: item.file_path ?? '',
    content: item.code_content ?? '',
    score: 1,  // not a similarity search — all results are exact matches
    language: item.language ?? '',
    startLine: Number(item.start_line ?? 0),
    endLine: Number(item.end_line ?? 0),
    name: item.name ?? '',
    chunkType: item.chunk_type ?? '',
  }))
}
```

- [ ] **Step 2: Add `queryByName` method**

```typescript
/**
 * Find code chunks with an exact name match.
 * Used for forward-direction analysis (find callees of a function).
 */
async queryByName(name: string, limit: number = 20, pathPrefix?: string): Promise<SearchResult[]> {
  const client = this.getClient()
  const { collection } = this

  const filter = `name == "${name}"`
  const expr = pathPrefix ? `file_path like "${pathPrefix}%" and ${filter}` : filter

  const response = await client.query({
    collection_name: collection,
    expr,
    output_fields: ['file_path', 'code_content', 'start_line', 'end_line', 'language', 'chunk_type', 'name', 'references'],
    limit,
  } as any)

  const items = (response.data ?? []) as any[]
  return items.map((item: any) => ({
    filePath: item.file_path ?? '',
    content: item.code_content ?? '',
    score: 1,
    language: item.language ?? '',
    startLine: Number(item.start_line ?? 0),
    endLine: Number(item.end_line ?? 0),
    name: item.name ?? '',
    chunkType: item.chunk_type ?? '',
    references: item.references ?? [],  // Include for forward direction callee extraction
  }))
}
```

- [ ] **Step 3: Insert `references` in `insertChunks`**

In the `insertChunks` method (line 325-334), add `references` to the data object:

```typescript
const response = await client.insert({
  collection_name: collection,
  data: batch.map((chunk) => ({
    vector: chunk.vector,
    file_path: chunk.filePath,
    code_content: chunk.content,
    start_line: chunk.startLine,
    end_line: chunk.endLine,
    language: chunk.language,
    chunk_type: chunk.chunkType,
    name: chunk.name,
    references: chunk.references ?? [],  // NEW
  })),
})
```

- [ ] **Step 4: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/milvus-service.ts src/plugins/dsh-context-milvus/indexer.ts
git commit -m "feat(relations): add queryByReference, queryByName, and insert references"
```

---

### Task 4: code-relations.ts (NEW) — BFS engine + denoising

**Files:**
- Create: `src/plugins/dsh-context-milvus/code-relations.ts`
- Test: `test/code-relations.spec.ts` (new, created in Task 6)

**Interfaces:**
- Consumes: `queryByReference(symbol, limit)` and `queryByName(name, limit)` (Task 3)
- Produces: `findCallers(symbol, direction, maxResults)` — single-level reference lookup
- Produces: `traceChain(entry, findFn, options)` — BFS chain traversal
- Produces: `isNoiseSymbol(symbol)` — denoising helper

- [ ] **Step 1: Create the module with type exports and denoising**

```typescript
/**
 * Code relationship analysis — BFS call chain engine and denoising logic.
 */

/** Result from a single-level reference lookup */
export interface RelationChunk {
  filePath: string
  content: string
  startLine: number
  endLine: number
  chunkType: string
  name: string
  references?: string[]  // Only populated for forward direction (callees)
}

/** Result of find_callers */
export interface CallersResult {
  chunks: RelationChunk[]
}

/** A node in the BFS call chain */
export interface ChainNode {
  depth: number
  symbol: string
  filePath: string
  startLine: number
  endLine: number
  callers: string[]  // symbols of calling functions at the next level down
}

/** Result of trace_call_chain */
export interface TraceResult {
  chain: ChainNode[]
}

/** Options for traceChain BFS */
export interface TraceOptions {
  direction?: 'backward' | 'forward'
  maxDepth?: number
  maxResults?: number
}

/** Single-level lookup function signature (injected by tools.ts) */
export type FindBySymbol = (
  symbol: string,
  direction: 'backward' | 'forward',
  maxResults: number,
) => Promise<RelationChunk[]>

/** Default stop words — symbols too generic for useful reference analysis */
export const DEFAULT_STOP_WORDS = new Set([
  'data', 'config', 'result', 'process', 'error', 'value', 'item', 'args',
  'options', 'tmp', 'temp', 'key', 'val', 'name', 'type', 'size', 'length',
  'index', 'count', 'total', 'status', 'msg', 'err', 'str', 'num', 'obj',
  'arr', 'fn', 'cb', 'done', 'next', 'promise', 'callback', 'resolve',
  'reject', 'then', 'catch', 'finally',
])

/** Check if a symbol is noise (too generic or too short) */
export function isNoiseSymbol(symbol: string): boolean {
  if (symbol.length <= 1) return true
  if (DEFAULT_STOP_WORDS.has(symbol)) return true
  return false
}
```

- [ ] **Step 2: Implement `findCallers` (single-level lookup)**

```typescript
/**
 * Single-level reference lookup.
 * Direction 'backward' = find chunks that reference the given symbol (callers).
 * Direction 'forward' = find chunks whose name matches the symbol, then return their references (callees).
 */
export async function findCallers(
  findBySymbol: FindBySymbol,
  symbol: string,
  direction: 'backward' | 'forward' = 'backward',
  maxResults: number = 20,
): Promise<CallersResult> {
  if (isNoiseSymbol(symbol)) {
    return { chunks: [] }
  }

  const chunks = await findBySymbol(symbol, direction, maxResults)
  return { chunks }
}
```

- [ ] **Step 3: Implement `traceChain` (BFS chain traversal)**

```typescript
/**
 * BFS chain traversal for trace_call_chain.
 * Starts from the entry symbol, expands level by level using findCallers.
 * Uses visited set to prevent cycles.
 */
export async function traceChain(
  findBySymbol: FindBySymbol,
  entry: string,
  options: TraceOptions = {},
): Promise<TraceResult> {
  const direction = options.direction ?? 'backward'
  const maxDepth = options.maxDepth ?? 3
  const maxResults = options.maxResults ?? 10

  if (isNoiseSymbol(entry)) {
    return { chain: [] }
  }

  const visited = new Set<string>()
  const chain: ChainNode[] = []
  let currentLevel: Array<{ symbol: string; depth: number }> = [{ symbol: entry, depth: 0 }]

  while (currentLevel.length > 0 && maxDepth > 0) {
    const nextLevel: Array<{ symbol: string; depth: number }> = []

    for (const item of currentLevel) {
      if (visited.has(item.symbol)) continue
      visited.add(item.symbol)

      const result = await findCallers(findBySymbol, item.symbol, direction, maxResults)
      const callerNames = result.chunks.map(c => c.name).filter(Boolean)

      // Deduplicate caller names
      const uniqueCallers = [...new Set(callerNames)]

      // The "callers" field: for backward direction, the callers are the
      // chunks that reference this symbol (their names). For forward
      // direction, the callers are the callees (symbols this function calls).
      let uniqueCallers: string[]
      if (direction === 'backward') {
        uniqueCallers = [...new Set(callerNames)]
      } else {
        // Forward: collect references (callees) from the definition chunks
        uniqueCallers = [...new Set(
          result.chunks.flatMap(c => c.references ?? [])
        )]
      }

      chain.push({
        depth: item.depth,
        symbol: item.symbol,
        filePath: result.chunks.length > 0 ? result.chunks[0].filePath : '',
        startLine: result.chunks.length > 0 ? result.chunks[0].startLine : 0,
        endLine: result.chunks.length > 0 ? result.chunks[0].endLine : 0,
        callers: uniqueCallers,
      })

      // Enqueue next level
      if (item.depth < maxDepth - 1) {
        for (const nextSymbol of uniqueCallers) {
          if (!visited.has(nextSymbol) && !isNoiseSymbol(nextSymbol)) {
            nextLevel.push({ symbol: nextSymbol, depth: item.depth + 1 })
          }
        }
      }
    }

    currentLevel = nextLevel
  }

  return { chain }
}
```

- [ ] **Step 4: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/code-relations.ts
git commit -m "feat(relations): add BFS engine and denoising module"
```

---

### Task 5: tools.ts — Register find_callers and trace_call_chain tools

**Files:**
- Modify: `src/plugins/dsh-context-milvus/tools.ts`
- Modify: `src/plugins/dsh-context-milvus/index.ts` (import and pass code-relations to tools)
- Test: `test/code-relations.spec.ts` (new, created in Task 6)

**Interfaces:**
- Consumes: `RelationChunk`, `findCallers`, `traceChain` (Task 4), `MilvusService.queryByReference` and `queryByName` (Task 3)
- Produces: registered DSH tools `find_callers` and `trace_call_chain`

- [ ] **Step 1: Add imports in tools.ts**

```typescript
import { findCallers, traceChain, isNoiseSymbol } from './code-relations.js'
import type { FindBySymbol } from './code-relations.js'
```

- [ ] **Step 2: Add `find_callers` tool registration**

```typescript
// ── find_callers ────────────────────────────────────────────────────

ctx.tools.register(
  defineTool({
    name: 'find_callers',
    description:
      '查找代码中引用某个符号（函数/变量/类）的所有位置。' +
      '用于代码修改影响分析：改了某个函数，看它被哪些地方调用了。' +
      'direction=backward 找引用者（影响面），direction=forward 找被调用者（依赖面）。',

    parameters: {
      symbol: {
        type: 'string',
        required: true,
        description: '要查找的符号名（函数名、变量名、类名）',
      },
      direction: {
        type: 'string',
        description: 'backward=谁引用了我（影响面，默认）；forward=我引用了谁（依赖面）',
      },
      maxResults: {
        type: 'number',
        description: '最大返回结果数，默认 20',
      },
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          chunks: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                filePath: { type: 'string' },
                content: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' },
                chunkType: { type: 'string' },
                name: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args: any, value: any) => {
        const result = value as { chunks: any[] }
        if (result.chunks.length === 0) {
          return [{ type: 'text' as const, text: '未找到引用该符号的代码。' }]
        }
        const lines = result.chunks.map((c: any, i: number) => {
          return [
            `[${i + 1}] ${c.filePath}:${c.startLine}-${c.endLine}`,
            `    ${c.chunkType}「${c.name}」`,
            c.content.length > 200 ? c.content.slice(0, 200) + '...' : c.content,
          ].join('\n')
        })
        return [{ type: 'text' as const, text: `找到 ${result.chunks.length} 个引用位置：\n\n${lines.join('\n---\n')}` }]
      },
    },

    async execute(params: any, exec?: any) {
      await milvus.ensureCollection()
      const direction = params.direction === 'forward' ? 'forward' as const : 'backward' as const
      const maxResults = params.maxResults ?? 20

      const findBySymbol: FindBySymbol = async (symbol, dir, limit) => {
        if (dir === 'backward') {
          const results = await milvus.queryByReference(symbol, limit)
          return results.map(r => ({
            filePath: r.filePath,
            content: r.content,
            startLine: r.startLine,
            endLine: r.endLine,
            chunkType: r.chunkType,
            name: r.name,
          }))
        } else {
          // Forward: find the definition, then collect its references
          const results = await milvus.queryByName(symbol, limit)
          // Return the definition chunks with their references (callees)
          return results.map(r => ({
            filePath: r.filePath,
            content: r.content,
            startLine: r.startLine,
            endLine: r.endLine,
            chunkType: r.chunkType,
            name: r.name,
            references: (r as any).references ?? [],
          }))
        }
      }

      return findCallers(findBySymbol, params.symbol, direction, maxResults)
    },
  }),
)
```

- [ ] **Step 3: Add `trace_call_chain` tool registration**

```typescript
// ── trace_call_chain ────────────────────────────────────────────────

ctx.tools.register(
  defineTool({
    name: 'trace_call_chain',
    description:
      '从入口符号出发，沿引用关系 BFS 追踪调用链。' +
      'direction=backward 做影响分析（找谁调用了入口），direction=forward 做依赖分析（入口调用了谁）。',

    parameters: {
      entry: {
        type: 'string',
        required: true,
        description: '入口符号名',
      },
      direction: {
        type: 'string',
        description: 'backward=影响分析（找调用者，默认）；forward=依赖分析（找被调用者）',
      },
      maxDepth: {
        type: 'number',
        description: '最大递归深度，默认 3',
      },
      maxResults: {
        type: 'number',
        description: '每层最大结果数，默认 10',
      },
    },

    output: {
      schema: {
        type: 'object',
        properties: {
          chain: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                depth: { type: 'number' },
                symbol: { type: 'string' },
                filePath: { type: 'string' },
                startLine: { type: 'number' },
                endLine: { type: 'number' },
                callers: {
                  type: 'array',
                  items: { type: 'string' },
                },
              },
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args: any, value: any) => {
        const result = value as { chain: any[] }
        if (result.chain.length === 0) {
          return [{ type: 'text' as const, text: '未找到调用链。' }]
        }
        const lines = result.chain.map((n: any) => {
          const indent = '  '.repeat(n.depth)
          const callerList = n.callers.length > 0
            ? `\n${indent}  └─ 调用者: ${n.callers.join(', ')}`
            : ''
          return `${indent}${n.symbol} (${n.filePath}:${n.startLine}-${n.endLine})${callerList}`
        })
        return [{
          type: 'text' as const,
          text: `调用链 (${result.chain.length} 层):\n\n${lines.join('\n')}`,
        }]
      },
    },

    async execute(params: any, exec?: any) {
      await milvus.ensureCollection()
      const direction = params.direction === 'forward' ? 'forward' as const : 'backward' as const
      const maxDepth = params.maxDepth ?? 3
      const maxResults = params.maxResults ?? 10

      const findBySymbol: FindBySymbol = async (symbol, dir, limit) => {
        if (dir === 'backward') {
          const results = await milvus.queryByReference(symbol, limit)
          return results.map(r => ({
            filePath: r.filePath,
            content: r.content,
            startLine: r.startLine,
            endLine: r.endLine,
            chunkType: r.chunkType,
            name: r.name,
          }))
        } else {
          const results = await milvus.queryByName(symbol, limit)
          return results.map(r => ({
            filePath: r.filePath,
            content: r.content,
            startLine: r.startLine,
            endLine: r.endLine,
            chunkType: r.chunkType,
            name: r.name,
            references: (r as any).references ?? [],
          }))
        }
      }

      return traceChain(findBySymbol, params.entry, { direction, maxDepth, maxResults })
    },
  }),
)
```

- [ ] **Step 4: Run build to verify compilation**

```bash
npm run build
```

- [ ] **Step 5: Commit**

```bash
git add src/plugins/dsh-context-milvus/tools.ts
git commit -m "feat(relations): register find_callers and trace_call_chain tools"
```

---

### Task 6: Tests — code-relations.spec.ts

**Files:**
- Create: `test/code-relations.spec.ts`

**Interfaces:**
- Consumes: all modules from Tasks 1-5
- Produces: comprehensive test coverage

- [ ] **Step 1: Create test file with mock-based tests**

```typescript
import { describe, expect, test, jest } from '@jest/globals'

// Mock the Milvus module
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: jest.fn(() => ({
    // mock methods as needed
  })),
  DataType: {
    Int64: 5,
    FloatVector: 101,
    VarChar: 21,
    Int32: 4,
    SparseFloatVector: 104,
  },
  MetricType: { COSINE: 'COSINE' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'RRF' },
  load: jest.fn(),
}))

describe('code-relations', () => {
  // ── Denoising ──────────────────────────────────────────────────────

  test('isNoiseSymbol filters single-character symbols', async () => {
    const { isNoiseSymbol } = await import('../src/plugins/dsh-context-milvus/code-relations.js')
    expect(isNoiseSymbol('a')).toBe(true)
    expect(isNoiseSymbol('x')).toBe(true)
    expect(isNoiseSymbol('ab')).toBe(false)
    expect(isNoiseSymbol('foo')).toBe(false)
  })

  test('isNoiseSymbol filters stop words', async () => {
    const { isNoiseSymbol } = await import('../src/plugins/dsh-context-milvus/code-relations.js')
    expect(isNoiseSymbol('data')).toBe(true)
    expect(isNoiseSymbol('config')).toBe(true)
    expect(isNoiseSymbol('result')).toBe(true)
    expect(isNoiseSymbol('parseConfig')).toBe(false)
  })

  // ── findCallers ────────────────────────────────────────────────────

  test('findCallers backward returns chunks that reference the symbol', async () => {
    const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, direction: string) => {
      return [
        { filePath: 'src/a.ts', content: '...', startLine: 1, endLine: 10, chunkType: 'function_declaration', name: 'callerA' },
        { filePath: 'src/b.ts', content: '...', startLine: 5, endLine: 15, chunkType: 'function_declaration', name: 'callerB' },
      ]
    }

    const result = await findCallers(mockFindBySymbol as any, 'targetFn', 'backward')
    expect(result.chunks).toHaveLength(2)
    expect(result.chunks[0].name).toBe('callerA')
    expect(result.chunks[1].name).toBe('callerB')
  })

  test('findCallers returns empty for noise symbols', async () => {
    const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async () => [{ filePath: 'x.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'x' }]

    const result = await findCallers(mockFindBySymbol as any, 'a', 'backward')  // single char
    expect(result.chunks).toHaveLength(0)
  })

  test('findCallers forward returns definition chunks', async () => {
    const { findCallers } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, direction: string) => {
      return [
        { filePath: 'src/def.ts', content: '...', startLine: 1, endLine: 10, chunkType: 'function_declaration', name: 'myFunc', },
      ]
    }

    const result = await findCallers(mockFindBySymbol as any, 'myFunc', 'forward')
    expect(result.chunks).toHaveLength(1)
    expect(result.chunks[0].filePath).toBe('src/def.ts')
  })

  // ── traceChain BFS ─────────────────────────────────────────────────

  test('traceChain BFS traverses backward chain', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, direction: string, limit: number) => {
      if (symbol === 'main') {
        return [{ filePath: 'src/index.ts', content: '', startLine: 1, endLine: 5, chunkType: 'function', name: 'runApp' }]
      }
      if (symbol === 'runApp') {
        return [{ filePath: 'src/app.ts', content: '', startLine: 10, endLine: 20, chunkType: 'function', name: 'initConfig' }]
      }
      return []
    }

    const result = await traceChain(mockFindBySymbol as any, 'main', { maxDepth: 3 })
    expect(result.chain.length).toBeGreaterThanOrEqual(2)
    expect(result.chain[0].symbol).toBe('main')
    expect(result.chain[0].callers).toContain('runApp')
  })

  test('traceChain respects maxDepth', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    let callCount = 0
    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      callCount++
      return [{ filePath: 'f.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'next' }]
    }

    await traceChain(mockFindBySymbol as any, 'start', { maxDepth: 1 })
    // With maxDepth=1, only the first level is searched (no expansion)
    expect(callCount).toBe(1)
  })

  test('traceChain prevents cycles', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      // Cycle: A → B → A
      if (symbol === 'A') {
        return [{ filePath: 'a.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'B' }]
      }
      if (symbol === 'B') {
        return [{ filePath: 'b.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'A' }]
      }
      return []
    }

    const result = await traceChain(mockFindBySymbol as any, 'A', { maxDepth: 5 })
    // Should not infinite loop
    expect(result.chain.length).toBeLessThanOrEqual(5)
    // Should have visited A and B (2 unique symbols)
    const symbols = result.chain.map(n => n.symbol)
    expect(symbols).toContain('A')
    expect(symbols).toContain('B')
  })

  test('traceChain returns empty for noise entry symbol', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async () => [{ filePath: 'f.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'x' }]

    const result = await traceChain(mockFindBySymbol as any, 'data', { maxDepth: 3 })  // stop word
    expect(result.chain).toHaveLength(0)
  })

  test('traceChain forward traverses callees via references', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      if (dir === 'forward') {
        if (symbol === 'main') {
          return [{ filePath: 'src/index.ts', content: '', startLine: 1, endLine: 5, chunkType: 'function', name: 'main', references: ['runApp'] }]
        }
        if (symbol === 'runApp') {
          return [{ filePath: 'src/app.ts', content: '', startLine: 10, endLine: 20, chunkType: 'function', name: 'runApp', references: ['initConfig'] }]
        }
      }
      return []
    }

    const result = await traceChain(mockFindBySymbol as any, 'main', { direction: 'forward', maxDepth: 3 })
    expect(result.chain.length).toBeGreaterThanOrEqual(2)
    expect(result.chain[0].callers).toContain('runApp')  // main calls runApp
    expect(result.chain[1].symbol).toBe('runApp')
    expect(result.chain[1].callers).toContain('initConfig')  // runApp calls initConfig
  })

  test('traceChain handles empty result mid-chain', async () => {
    const { traceChain } = await import('../src/plugins/dsh-context-milvus/code-relations.js')

    const mockFindBySymbol = async (symbol: string, dir: string, limit: number) => {
      if (symbol === 'entry') {
        return [{ filePath: 'e.ts', content: '', startLine: 1, endLine: 1, chunkType: 'function', name: 'leaf' }]
      }
      return []  // 'leaf' has no callers
    }

    const result = await traceChain(mockFindBySymbol as any, 'entry', { maxDepth: 3 })
    expect(result.chain).toHaveLength(2)  // entry → leaf
    expect(result.chain[0].callers).toContain('leaf')  // entry is referenced by leaf
    expect(result.chain[1].callers).toHaveLength(0)  // leaf has no further callers
  })
})
```

- [ ] **Step 2: Run the test to verify it passes**

```bash
node --experimental-vm-modules node_modules/.bin/jest test/code-relations.spec.ts --verbose
```

- [ ] **Step 3: Commit**

```bash
git add test/code-relations.spec.ts
git commit -m "test(relations): add unit tests for code-relations module"
```

---

### Task 7: AGENTS.md — Documentation

**Files:**
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: nothing
- Produces: updated AGENTS.md with new tool entries and usage rules

- [ ] **Step 1: Add tool entries to the tools table**

Add `find_callers` and `trace_call_chain` to the tools table in AGENTS.md:

```markdown
| `find_callers` | 查找代码中引用某个符号的所有位置，用于修改影响分析 | `symbol`(必填)、`direction`、`maxResults` |
| `trace_call_chain` | 从入口符号出发 BFS 追踪调用链，支持影响分析和依赖分析 | `entry`(必填)、`direction`、`maxDepth`、`maxResults` |
```

- [ ] **Step 2: Add usage rules**

Add after the existing rules:

```markdown
7. **修改代码前用 find_callers 做影响分析**

   在修改或重命名函数/变量/类之前，先调用 `find_callers` 看哪些地方引用了它，避免遗漏连锁影响。

8. **理解功能调用链用 trace_call_chain**

   当需要理解一个功能的完整调用链路时，从入口函数开始用 `trace_call_chain direction=backward` 追踪调用者，或用 `direction=forward` 追踪其调用的下游函数。
```

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs(relations): add find_callers and trace_call_chain to AGENTS.md"
```