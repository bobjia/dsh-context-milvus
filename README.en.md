# dsh-context-milvus

[![npm version](https://img.shields.io/npm/v/dsh-context-milvus)](https://www.npmjs.com/package/dsh-context-milvus)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/bobjia/dsh-context-milvus)

A DSH plugin that provides semantic code search over a **Milvus** vector database, with a complete index ↔ search pipeline.

> dsh-context-milvus = **equips your DSH Agent with a dedicated codebase semantic search engine. Milvus handles high-speed vector retrieval, transforming "needle-in-a-haystack grep" into precise recall of relevant code snippets — reducing tokens, minimizing tool calls, and improving coding agent quality on large repositories**.

---

## Why dsh-context-milvus?

`dsh-context-milvus` is an open-source code semantic search plugin for **DeepSeek Harness (DSH) coding agents**, built on Milvus as the vector database and registered as a Cordis Plugin. Its core purpose: **solve the high token consumption, excessive tool calls, context pollution, and poor large-codebase comprehension that plague native DSH Agent grep workflows**.

> Native DSH Agent workflow: encounter a problem → repeatedly `search_code` (grep) → `read` files → search again, flooding the prompt with irrelevant text, exploding tool calls, increasing token costs, and making it easy to miss dependencies in large repositories.

### Solving the key pain points of native grep search

| Native grep workflow pain point | dsh-context-milvus solution |
|---|---|
| Literal string matching only — semantically related but differently named code is missed | **Vector semantic search** — matches by code meaning, not just keywords |
| Multiple tool call rounds, reading many irrelevant files, token explosion | Returns only truly relevant code snippets, split by AST at function/class boundaries for precision |
| Flooding context with grep output and irrelevant source code, causing **context pollution** and degraded model reasoning | Milvus pre-built index, Agent gets concise effective context in one tool call without search noise in the prompt |
| Thousands of files in large repos, Agent traversal is extremely inefficient | Milvus vector DB enables fast retrieval over millions of code blocks, supports incremental index updates without full repo rescanning |
| Can only search already-open or known-path files | After full-repo indexing, can semantically search any code location regardless of file path knowledge |

---

## Features

- **`search_code`** — Semantic code search: natural language query, returns matching code snippets
- **`index_code`** — Index codebase: AST parsing + chunking → Embedding → Milvus storage
- **`index_status`** — View index status: file count, last index time, hash statistics
- **`find_callers`** — Code relationship analysis (impact analysis): find all references to a symbol, with cross-file import resolution
- **`trace_call_chain`** — Call chain tracing: BFS expansion from entry symbol (impact/dependency analysis), with cross-file resolution disambiguation
- **Hybrid search** — BM25 keyword + vector semantic dual-path retrieval, RRF fusion, `hybridMode` toggle
- **Ignore pattern system** — Three-layer gitignore-style ignore rules (default + codebase + global)
- **Incremental indexing** — Merkle SHA-256 hash tracking, processes only changed files
- **Workspace isolation** — Independent Merkle state files per workspace, no interference
- **ADR decision memory system** — Records design rationale behind code changes (Architecture Decision Records), supports semantic search, CRUD, constraint injection, and consistency checking
- **Code relationship analysis** — Extracts symbol references from AST during indexing (`references`, language-specific syntax nodes), supports cross-file exact matching
- **Cross-file import resolution (V2)** — Scans import/export statements using tree-sitter AST during indexing, builds a persistent bidirectional Import Map, enabling `find_callers`/`trace_call_chain` to perform precise cross-file symbol matching (same-name disambiguation, cross-module tracing)

---

## What role does Milvus play, and why Milvus?

1. **Stores AST-chunked code vectors**: dsh-context-milvus uses tree-sitter AST to split code at function/class/method boundaries, generates embeddings, and stores them in Milvus — avoiding cutting a function in half.
2. **High-performance vector search**: Encodes the query and performs vector similarity search with low latency, suitable for real-time Agent tool calls.
   > Note: BM25 keyword fusion is **already implemented** — Milvus native BM25 full-text search + vector semantic dual-path retrieval, RRF fusion (`hybridMode` enabled by default).
3. **Supports self-hosted Milvus / Zilliz Cloud**, two deployment options; teams can control data; supports incremental indexing after code changes without full rebuild.
4. **Specifically adapted for code RAG**: Supports path-scoped filtering (`search_code` `path` parameter), allowing directory-limited searches — ideal for codebase scenarios.

---

## DSH plugin architecture advantages

It is not a standalone MCP service, but a **DSH plugin** (Cordis Plugin) embedded directly into the DSH Agent process:

- **Zero network overhead**: Plugin and Agent share the same process, tool calls don't go through HTTP, latency far below MCP
- **Naturally shares DSH resource configuration**: Reuses DSH's config management, environment variable injection, and logging system — no additional configuration needed
- **DSH Web GUI integration**: Visual configuration through Settings → Plugins interface, no YAML hand-editing
- **DSH ecosystem compatibility**: Shares the tool registry with other DSH plugins (bash, agent-loop, web-search, etc.), Agents can freely combine them

---

## Core Workflow

### Registered DSH tools

| Tool | Function | Key Parameters |
|------|----------|----------------|
| `search_code` | Semantic code search | `query` (natural language), `topK` (result count), `path` (search scope) |
| `index_code` | Index codebase | `mode` (full/incremental), `path` (target path) |
| `index_status` | View index status | `path` (view per-workspace status) |
| `search_adr` | Semantic ADR search | `query` (natural language), `status`, `topK` |
| `search_adr_by_file` | Find ADRs by file path | `file_path` (code file path), `status` |
| `create_adr` | Create new ADR | `title` (required), `requirement`, `change_type` |
| `update_adr` | Update existing ADR | `adr_id` (required), `content`, `status` |
| `list_adrs` | List ADR records | `status`, `change_type`, `limit` |
| `load_constraints` | Load active ADR constraints | `adr_ids`, `format` |
| `check_adr_consistency` | Check ADR-code consistency | `file_path`, `fix` |
| `find_callers` | Find all references to a symbol for impact analysis, supports cross-file import resolution | `symbol` (required), `direction`, `maxResults`, `sourceFile`, `resolve` |
| `trace_call_chain` | BFS call chain tracing from entry symbol (impact/dependency analysis), supports import resolution disambiguation | `entry` (required), `direction`, `maxDepth`, `maxResults`, `resolve` |

### Workflow

1. Run `index_code`: Parse the project, split code blocks via tree-sitter AST → call Embedding API to generate vectors → store in Milvus collection.
2. Agent encounters a coding problem, calls `search_code` for **hybrid search** (vector semantic + BM25 keyword, RRF fusion).
3. Milvus returns the most relevant code snippets, injected into the Agent's context.
4. Agent debugs, refactors, or develops based on precise context — no more frantic grep file reading.
5. After code changes, run `index_code mode=incremental` to incrementally re-index only changed files.
6. Check index status anytime with `index_status` (indexed files, total code blocks, last index time).
7. Before modifying code, use `find_callers` for impact analysis: see which places reference the symbol to avoid missing cascading effects. For same-name symbols across files, use the `sourceFile` parameter to disambiguate by definition file.
8. Understand call chains with `trace_call_chain`: BFS expansion from entry function, `direction=backward` traces callers, `direction=forward` traces downstream dependencies. `resolve: false` falls back to V1 name-matching mode.
9. Cross-file reference analysis: `find_callers` and `trace_call_chain` enable import resolution by default (`resolve: true`). The Import Map built during indexing automatically maps `import { X } from './foo'` to `foo.ts`'s exports, eliminating same-name ambiguity and supporting cross-module call chain tracing. Falls back to V1 name matching when the import map is not built.

### ADR decision memory workflow

The ADR decision memory system records the "why" behind code changes (design decisions, trade-offs, constraints), enabling the Agent to not only read code but understand its evolution:

> **Note:** ADR functionality is disabled by default. To enable it, set `adrEnabled: true` in the DSH config panel (Settings → Plugins → dsh-context-milvus).

1. **Before modifying code with ADR coverage**, use `search_adr_by_file` to check if the file has decision records, avoiding violation of existing decisions.
2. **When making design decisions**, use `create_adr` to record the context, alternatives, and rationale, and use `update_adr` to maintain code_anchors linking to code locations.
3. **When needing to understand constraints**, use `load_constraints` to load active ADR constraints into the context.
4. **After creating or updating ADRs**, use `check_adr_consistency` to verify ADR-code consistency, with `fix` for auto-repair.
5. Use `search_adr` for semantic search of historical decisions, understanding "why this was done this way."

---

## Spec Document Fusion

When the brainstorming skill produces specification documents, they can be linked to the codebase through the following steps:

1. **Write spec documents**: brainstorming output saved to `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`
2. **Generate anchors**: Call `index_specs` to automatically detect code references in the document and generate frontmatter + code_anchors
3. **Index**: `index_code` automatically scans `docs/superpowers/specs/` and `docs/superpowers/plans/` directories
4. **Discover**: `search_adr` returns both ADR and spec document results (with `docType` annotation)

### Configuration

| Field | Default | Description |
|-------|---------|-------------|
| `specRoot` | `docs/superpowers/specs` | Spec document directory (relative to indexRoot) |
| `planRoot` | `docs/superpowers/plans` | Implementation plan directory (relative to indexRoot) |

Spec document fusion follows the `adrEnabled` toggle — no additional configuration needed.

---

## Prerequisites

### 1. Install Ollama (Embedding service)

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# Start Ollama service
ollama serve
```

> Or use any OpenAI-compatible Embedding API service (OpenAI, Alibaba Cloud Bailian, etc.) by configuring `embeddingEndpoint` and `embeddingApiKey`.

### 2. Install Embedding model

```bash
# Pull nomic-embed-text model (default)
ollama pull nomic-embed-text

# Or other supported Embedding models:
ollama pull bge-m3
ollama pull mxbai-embed-large
```

### 3. Install Milvus (vector database)

**Docker (recommended):**

```bash
# Pull and start Milvus standalone
docker run -d --name milvus \
  -p 19530:19530 \
  -p 9091:9091 \
  milvusdb/milvus:latest

# Verify connection
docker ps | grep milvus
```

**Milvus cluster mode (Docker Compose):**

```bash
# Download docker-compose file
wget https://github.com/milvus-io/milvus/releases/latest/download/milvus-standalone-docker-compose.yml -O docker-compose.yml

# Start
docker compose up -d
```

> Or use [Zilliz Cloud](https://cloud.zilliz.com) managed service — no self-hosting required.

### Verify installation

```bash
# Verify Ollama
curl http://localhost:11434/api/tags

# Verify Milvus
docker run -it --rm \
  -e MILVUS_URL=localhost:19530 \
  milvusdb/milvus-sdk-node:latest \
  node -e "const {MilvusClient} = require('@zilliz/milvus2-sdk-node'); \
  new MilvusClient({address:'localhost:19530'}).listCollections().then(r=>console.log(r))"
```

---

## Install to DSH

### Method 1: From npm (recommended)

The plugin is published to the npm registry. Install directly via DSH CLI:

```bash
dsh plugin --profile web add dsh-context-milvus
```

> The npm package includes pre-built `dist/` output — no build step required during installation, avoiding the `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` error.

### Method 2: From local tarball (offline / local development)

Build and package as a tarball, then install directly:

```bash
# 1. Build
npm run build

# 2. Package as tarball
pnpm pack

# 3. Install to profile
dsh plugin --profile web add ./dsh-context-milvus-0.1.3.tgz
```

> `pnpm pack` produces a tarball containing the compiled `dist/` output — no build step required during installation, so pnpm won't raise `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`.

### Method 3: From Git (requires additional configuration)

```bash
dsh plugin --profile web add git+https://github.com/bobjia/dsh-context-milvus.git
```

> `dist/` output is not committed to git. The plugin uses the `prepare` script to automatically run `tsc` during installation.
>
> **pnpm 10 limitation**: pnpm 10 blocks execution of build scripts by default. If you see:
> ```
> ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
> The git-hosted package "dsh-context-milvus@0.1.2" needs to execute build scripts
> but is not in the "onlyBuiltDependencies" allowlist.
> ```
> Add to your profile's `pnpm-workspace.yaml`:
> ```yaml
> # ~/.dsh/profiles/<profile-name>/pnpm-workspace.yaml
> onlyBuiltDependencies:
> - dsh-context-milvus
> ```
> Then re-run the install command. Or run `pnpm approve-builds` and select `dsh-context-milvus`.
>
> To avoid this authorization, use Method 1 (npm) or Method 2 (tarball).

### Configure the plugin

After installation, edit `cordis.patch.yml` under your profile:

```yaml
# ~/.dsh/profiles/<profile-name>/cordis.patch.yml
- id: dsh-context-milvus
  config:
    milvusAddress: localhost:19530
    milvusCollection: code_embeddings
    milvusDim: 768
    embeddingEndpoint: http://localhost:11434/api/embed
    embeddingModel: nomic-embed-text
    indexRoot: /path/to/your/code
    indexExtensions: .ts,.tsx,.js,.py,.java,.go,.rs,.cpp,.cs,.scala,.php
    hybridMode: true
    bm25RrfK: 60
```

Restart DSH after configuration.

### Build from source (local development)

If using a local development version:

#### 1. Install dependencies

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm install --legacy-peer-deps
```

#### 2. Create symlinks for @deepseek-ai packages

```bash
# Link DSH runtime packages (npm install may break these links)
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis \
  node_modules/@deepseek-ai/cordis
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools \
  node_modules/@deepseek-ai/dsh-tools
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery \
  node_modules/@deepseek-ai/schemastery
```

#### 3. Register with DSH

```bash
# Install as local dependency
dsh plugin --profile web add file:/mnt/home/bobjia/workspace/dsh-context-milvus
```

> `dsh plugin add` automatically adds the plugin to `dsh.profile.bundles` — no need to manually edit `package.json`.

#### 4. Configure plugin

Edit `~/.dsh/profiles/<profile-name>/cordis.patch.yml` (same as above) and restart DSH.

---

## Configuration System

### Priority (highest → lowest)

1. **Cordis Config** (set via `cordis.patch.yml` or DSH Web GUI)
2. **Environment variables** (fallback)
3. **Defaults** (e.g., `localhost:19530`)

### Configuration fields

| Field | Environment Variable | Type | Default | Description |
|-------|---------------------|------|---------|-------------|
| `milvusAddress` | `MILVUS_ADDRESS` | string | `localhost:19530` | Milvus server address |
| `milvusToken` | `MILVUS_TOKEN` | string (secret) | empty | Milvus auth token |
| `milvusCollection` | `MILVUS_COLLECTION` | string | `code_embeddings` | Collection name |
| `milvusDim` | `MILVUS_EMBEDDING_DIM` | number | `768` | Vector dimension |
| `embeddingEndpoint` | `EMBEDDING_ENDPOINT` | string | `http://localhost:11434/api/embed` | Embedding API URL |
| `embeddingApiKey` | `EMBEDDING_API_KEY` | string (secret) | empty | Embedding API key |
| `embeddingModel` | `EMBEDDING_MODEL` | string | `nomic-embed-text` | Embedding model name |
| `indexRoot` | `INDEX_ROOT` | string | `process.cwd()` | Code repository root path |
| `indexExtensions` | `INDEX_EXTENSIONS` | string | all supported extensions | File extensions to index (comma-separated) |
| `hybridMode` | `HYBRID_MODE` | boolean | `true` | Enable hybrid search (BM25 full-text + vector semantic, RRF fusion) |
| `bm25RrfK` | `BM25_RRF_K` | number | `60` | RRF fusion parameter k |
| `indexIgnoreDirs` | `INDEX_IGNORE_DIRS` | string | dist, build, target, vendor, ... | Directories to skip during scan |
| `ignorePatterns` | `IGNORE_PATTERNS` | string (textarea) | empty | Custom gitignore-style ignore rules |
| `merkleFilePath` | `MERKLE_FILE_PATH` | string | `~/.milvus-index/merkle-{name}-{hash}.json` | Merkle state file path |

---

## Tool Reference

### `search_code`

Semantic code search. Automatically invoked when the user asks about code functionality, logic, or needs to find code by natural language.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `query` | string | yes | — | Natural language query |
| `topK` | number | no | 5 | Maximum results to return |
| `path` | string | no | (configured root) | Path scope for search |

**Return format:**

```json
[
  {
    "filePath": "src/auth/login.ts",
    "content": "export async function loginUser(credentials) { ... }",
    "score": 0.92,
    "language": "typescript",
    "chunkType": "function_declaration",
    "name": "loginUser",
    "startLine": 42,
    "endLine": 68
  }
]
```

### `index_code`

Index the codebase. Supports two modes:

- **`full`** — Full index of all files
- **`incremental`** — Incremental index (only changed files, based on Merkle hash)

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `mode` | string | no | `incremental` | Index mode: `full` or `incremental` |
| `path` | string | no | (configured root) | Path to index |

### `index_status`

View index status, including file count, total code blocks, last index time, etc.

### `find_callers`

Find all references to a symbol (function/variable/class) in the codebase, for impact analysis. V2 adds cross-file import resolution: use `sourceFile` to disambiguate same-name symbols across files.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `symbol` | string | yes | — | Symbol name to find (function, variable, class) |
| `direction` | string | no | `backward` | `backward`=who references me (impact); `forward`=who I reference (dependency) |
| `maxResults` | number | no | 20 | Maximum results |
| `sourceFile` | string | no | — | Definition file path (explicit disambiguation: only return callers that import from this file) |
| `resolve` | boolean | no | `true` | Whether to enable import resolution (`false` falls back to V1 name-matching) |

**Return format:**

```json
{
  "chunks": [
    {
      "filePath": "src/auth/login.ts",
      "content": "export async function loginUser(credentials) { ... }",
      "startLine": 42,
      "endLine": 68,
      "chunkType": "function_declaration",
      "name": "loginUser",
      "resolution": {
        "status": "resolved",
        "targetFile": "src/auth/session.ts",
        "exportedAs": "loginUser"
      }
    }
  ]
}
```

> `resolution` field: `status` is `resolved` (resolved to a cross-file import), `local` (defined in the same file), or `unresolved` (fallback to V1 name-matching). Only present when import resolution is enabled and the Import Map is built.

### `trace_call_chain`

Starting from the entry symbol, BFS-traverses the call chain along reference relationships. `direction=backward` for impact analysis (find who calls the entry), `direction=forward` for dependency analysis (what the entry calls). Uses a visited set to prevent cycles. V2 supports import resolution disambiguation (`resolve: true` by default), using `filePath:symbol` composite keys for cross-file call chain tracing.

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `entry` | string | yes | — | Entry symbol name |
| `direction` | string | no | `backward` | Traversal direction |
| `maxDepth` | number | no | 3 | Maximum recursion depth |
| `maxResults` | number | no | 10 | Maximum results per level |
| `resolve` | boolean | no | `true` | Whether to enable import resolution (`false` falls back to V1) |

**Return format:**

```json
{
  "chain": [
    {
      "depth": 0,
      "symbol": "main",
      "filePath": "src/index.ts",
      "startLine": 1,
      "endLine": 5,
      "callers": ["runApp"]
    },
    {
      "depth": 1,
      "symbol": "runApp",
      "filePath": "src/app.ts",
      "startLine": 10,
      "endLine": 20,
      "callers": ["initConfig"]
    }
  ]
}
```

---

## Code Chunking

| Language | Extensions | Chunking method | Covered AST node types |
|----------|-----------|-----------------|------------------------|
| TypeScript | .ts, .tsx, .mts, .cts | tree-sitter | function_declaration, method_definition, class_declaration, interface_declaration, enum_declaration, type_alias_declaration, arrow_function, generator_function, getter, setter |
| JavaScript | .js, .jsx, .mjs, .cjs | tree-sitter | function_declaration, method_definition, class_declaration, arrow_function, generator_function, getter, setter |
| Python | .py | tree-sitter + regex fallback | function_definition, class_definition, async_function_definition, decorated_definition |
| Java | .java | tree-sitter + regex fallback | class_declaration, interface_declaration, enum_declaration, method_declaration, constructor_declaration, record_declaration |
| Go | .go | tree-sitter + regex fallback | function_declaration, method_declaration, type_declaration, type_spec |
| Rust | .rs | tree-sitter + regex fallback | function_item, impl_item, trait_item, struct_item, enum_item, macro_definition |
| C++ | .cpp, .cxx, .cc, .hpp, .h, .hh | tree-sitter + regex fallback | function_definition, class_specifier, namespace_definition, struct_specifier, enum_specifier |
| C# | .cs | tree-sitter + regex fallback | method_declaration, class_declaration, interface_declaration, struct_declaration, enum_declaration |
| Scala | .scala | tree-sitter + regex fallback | class_definition, function_definition, trait_definition, object_definition, constructor_definition |
| PHP | .php | regex fallback | function_definition, class_declaration, interface_declaration, trait_declaration, enum_declaration |

> All languages except PHP (regex-only) use tree-sitter AST parsing as the primary method. Python, Java, Go, Rust, C++, C#, and Scala automatically fall back to regex when tree-sitter parsing fails; **TypeScript / JavaScript have no regex fallback** — if tree-sitter parsing fails, the file is skipped (no index entry).

---

## Ignore Pattern System (IgnoreMatcher)

Three-layer gitignore-style file ignore rules, ensuring only the code files that need analysis are indexed:

### Three rule layers

1. **Built-in defaults**: Automatically excludes `node_modules/`, `dist/`, `build/`, `.git/`, `__pycache__/`, `*.log`, `*.min.js`, and 30+ common build artifacts and dependency directories
2. **Codebase ignore files**: Automatically reads `.gitignore`, `.ignore`, `.xxxignore`, etc. from the codebase root
3. **Global ignore file**: Reads `~/.context/.contextignore` (user-level global rules)

### Automatic hidden path protection

Automatically ignores path segments starting with `.` (e.g., `.git/`, `.vscode/`, `.env`), preventing hidden directories and files from being indexed.

### Backward compatibility

The `indexIgnoreDirs` config (comma-separated directory names) is automatically converted to gitignore-style patterns (e.g., `dist` → `**/dist/**`), maintaining compatibility with older versions.

---

## Incremental Indexing & Workspace Isolation

### Incremental Indexing (Merkle hash tracking)

- Uses SHA-256 hash tracking for each file's content changes
- Only re-indexes new or modified files; skips unchanged files
- Deleted files are automatically removed from Milvus
- State is persisted to a local JSON file

### Workspace Isolation

- Different workspaces use independent Merkle state files
- State file paths are generated based on the workspace path's SHA-256 hash
- Indexing different workspaces does not interfere with each other
- The `path` parameter in tool calls specifies the workspace, automatically using the corresponding state file

---

## When to Use (and When Not To)

### ✅ Suitable Scenarios

- Codebases from tens of thousands to millions of lines, using DSH Agent for refactoring, bug localization, or cross-file reading
- Want to reduce token overhead and minimize Agent grep tool loops
- Need an open-source, self-hostable solution, avoiding closed-source indexing services
- Already using the DSH framework and want to enhance Agent code comprehension
- Need incremental indexing — code changes frequently but don't want full rebuilds every time

### ❌ Not Suitable / Caveats

1. Requires an embedding API (OpenAI / Ollama, etc.), code snippets are sent to the embedding service during indexing; for high-privacy requirements, use Ollama local embeddings
2. Adds Milvus / Zilliz Cloud as a dependency, increasing operational complexity; small codebases (a few hundred files) may not see significant benefit
3. It is a **retrieval augmentation tool**, **not a replacement for the model's context window** — it filters high-quality context to solve "signal overload," not to infinitely expand the window
4. Requires DSH environment (v0.6+), cannot run independently of DSH

---

## Comparison: DIY Code RAG vs dsh-context-milvus

If you build your own code RAG for DSH Agent: you'd need to handle AST chunking, vector search tuning, incremental sync, DSH tool wrapping, result ranking, and ignore file systems. dsh-context-milvus packages all of this engineering into a plug-and-play solution, specifically tuned for code scenarios.

| Dimension | DIY Code RAG | dsh-context-milvus |
|-----------|-------------|-------------------|
| AST Chunking | Integrate tree-sitter yourself, configure per language | Built-in 10-language tree-sitter chunking, auto fallback to regex |
| Semantic Search | Call embedding service and tune parameters yourself | Built-in vector semantic search, plug-and-play (BM25 keyword fusion) |
| Incremental Indexing | Implement file hash comparison and state management yourself | Built-in Merkle file state tracking, SHA-256, incremental updates |
| Workspace Isolation | Handle multi-workspace state conflicts yourself | Automatic path-hash-based isolation, no interference |
| Ignore Files | Implement .gitignore parsing yourself | Built-in three-layer ignore rule system (default + codebase + global) |
| DSH Tool Wrapping | Wrap DSH tools yourself (defineTool) | 13 native DSH tools (5 code tools + 8 ADR tools), one-click registration, formatted output |
| Configuration UI | Build yourself or hand-write YAML | DSH Web GUI visual configuration, 13 config fields |
| Config Sources | Single source | Three-source merge (Cordis Config > env vars > defaults) |
| Index Status | Build yourself | Built-in `index_status` tool, real-time index status |

---

## DSH Web Configuration

After installation, go to the DSH Web interface (http://127.0.0.1:3080) **Settings → Plugins** to see `dsh-context-milvus` and its configuration form, supporting:

- Text inputs (standard fields)
- Password inputs (secret fields like `milvusToken`, `embeddingApiKey`)
- Number inputs (number fields like `milvusDim`)
- Toggles (boolean fields like `hybridMode`)
- Field descriptions / help text

---

## Architecture

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                    DSH Agent / Web UI                                              │
│  search_code  │  index_code  │  index_status │  find_callers  │  trace_call_chain │
│  search_adr   │  create_adr  │  list_adrs    │  load_constraints                │
│  check_adr_consistency                                                           │
└───────────────────────────────────────────────────────────────────────────────────┘
                        │
┌───────────────────────────────────────────────────────────────────────────────────┐
│                  dsh-context-milvus                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  ┌──────────────────┐  │
│  │ chunker  │→ │embedding │→ │  milvus  │  │  merkle    │  │  ADR module set  │  │
│  │(AST+regex)│  │  client  │  │ service  │  │  tracker   │  │ frontmatter/     │  │
│  └────┬─────┘  └──────────┘  └────┬─────┘  └────────────┘  │ chunker/anchor/  │  │
│       │                           │                        │ service/indexer/  │  │
│  ┌────▼───────────────────────────▼───┐                    │ tools/constraint  │  │
│  │  code-relations.ts (BFS engine)    │                    └──────────────────┘  │
│  │  findCallers / traceChain          │                                          │
│  └────────────────────────────────────┘                                          │
│  ┌──────────────────────────────┐  ┌──────────────────────────────────────────┐  │
│  │  import-resolver.ts          │  │  ignore-matcher (gitignore-style 3-layer) │  │
│  │  Import Map (persistent bi-  │  │  ① DEFAULT_IGNORE_PATTERNS → ② codebase  │  │
│  │  directional resolution)     │  │  ③ ~/.context/.contextignore             │  │
│  └──────────────────────────────┘  └──────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────────────────────────┘
                        │
              ┌─────────┴─────────┐
              │                   │
        ┌──────────┐       ┌──────────┐
        │  Milvus  │       │Embedding │
        │ (vector DB)      │   API    │
        └──────────┘       └──────────┘
```

### Module dependency graph

```
index.ts (entry point)
  ├── config.ts     — Config resolution (Cordis config > env vars > defaults)
  │     └── DEFAULT_IGNORE_PATTERNS — Built-in gitignore-style ignore rules
  ├── milvus-service.ts — Milvus vector DB client wrapper (CRUD, search)
  │     └── embedding.ts — OpenAI-compatible Embedding API client
  ├── merkle.ts     — SHA-256 hash tracker (incremental indexing, persisted to JSON)
  ├── tools.ts      — DSH tool definitions, formatting, workspace-aware tracker creation
  │     └── code-relations.ts — Code relationship analysis engine (BFS call chain + dedup)
  │           └── import-resolver.ts — Cross-file Import Map (tree-sitter AST import/export scan)
  ├── ignore-matcher.ts — gitignore-style pattern matching (file exclusion)
  └── indexer.ts    — Indexing pipeline orchestration
        └── chunker.ts — tree-sitter AST chunking + regex fallback (includes references extraction + language import/export config)
  └── adr-frontmatter.ts — YAML frontmatter parsing
  └── adr-chunker.ts     — Markdown section chunking
  └── adr-anchor-index.ts — code_anchors reverse index
  └── adr-service.ts     — ADR CRUD + state management
  └── adr-indexer.ts     — ADR indexing pipeline
  └── adr-tools.ts       — 8 ADR tools
  └── constraint-injector.ts — System prompt injection + re-injection
```

---

## Testing

```bash
# Run all tests
npm test

# Test coverage
npm run test:coverage

# Single test file
npx jest test/dsh-context-remdb.spec.ts

# Code relationship analysis tests
npx jest test/code-relations.spec.ts

# Cross-file Import Resolution tests
npx jest test/import-resolver.spec.ts

# ADR module tests
npx jest test/adr-frontmatter.spec.ts
npx jest test/adr-chunker.spec.ts
npx jest test/adr-anchor-index.spec.ts
npx jest test/adr-service.spec.ts
npx jest test/adr-indexer.spec.ts
npx jest test/adr-tools.spec.ts
npx jest test/constraint-injector.spec.ts
```

---

## Development

```bash
# Build
npm run build

# Type check (no output)
npx tsc --noEmit

# Run tests (verbose)
node --experimental-vm-modules node_modules/.bin/jest --no-cache --verbose
```

---

## Dependencies

- [@zilliz/milvus2-sdk-node](https://github.com/milvus-io/milvus-sdk-node) — Milvus Node.js SDK
- `ignore` — gitignore-style pattern matching
- `tree-sitter` — AST parsing engine
- `tree-sitter-typescript` — TypeScript/JSX grammar
- `tree-sitter-python` — Python grammar
- `tree-sitter-java` — Java grammar
- `tree-sitter-go` — Go grammar
- `tree-sitter-rust` — Rust grammar
- `tree-sitter-cpp` — C++ grammar
- `tree-sitter-c-sharp` — C# grammar
- `tree-sitter-scala` — Scala grammar
- `@deepseek-ai/cordis` — DSH framework (provided by DSH runtime)
- `@deepseek-ai/dsh-tools` — DSH tool registration API (provided by DSH runtime)
- `@deepseek-ai/schemastery` — Config schema definition (provided by DSH runtime)

---

## License

MIT