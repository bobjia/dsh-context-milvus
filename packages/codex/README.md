# codex-context-milvus

Semantic code search for [OpenAI Codex CLI](https://github.com/openai/codex): an MCP (stdio) server that indexes your repository into a Milvus vector database with AST-aware chunking, then answers natural-language code queries.

One shared engine (`dsh-context-milvus-core`) powers both the DSH plugin and this MCP server, so the search behaviour — hybrid BM25 + vector retrieval, query expansion, two-stage reranking, incremental Merkle indexing, cross-file import resolution — is identical on both sides.

## Install

```bash
# Global
npm i -g codex-context-milvus

# Or run without installing (used by all examples below)
npx -y codex-context-milvus mcp
```

Requires Node.js ≥ 18 and Codex CLI 0.147+.

## Offline install (air-gapped target)

The production closure is ~230 packages, so an air-gapped machine needs the whole tree carried over — `npm pack` of this package alone is not enough. Prepare the payload on any machine that can reach the registry; both methods below start from the same scratch install:

```bash
mkdir ctxmilvus-offline && cd ctxmilvus-offline
npm init -y
npm pkg set dependencies.codex-context-milvus=0.2.0   # pin the version you are deploying
npm install --omit=dev --cache ./npm-cache            # resolve + download the full closure
```

**A. Carry the npm cache** — the target still installs with npm, so bin links and install-time wiring stay npm's job:

```bash
tar czf ctxmilvus-offline.tgz npm-cache package.json package-lock.json

# on the target
tar xzf ctxmilvus-offline.tgz
npm ci --omit=dev --offline --cache ./npm-cache                           # into ./node_modules
npm i -g codex-context-milvus@0.2.0 --offline --cache "$PWD/npm-cache"     # or globally
```

Keep the `--offline` flag: it makes npm fail with `ENOTCACHED` on a tarball it does not have, instead of hanging on a network that is not there. The cache must come from the scratch install above — it holds the tarballs *and* the version metadata `--offline` resolves against.

**B. Carry `node_modules` verbatim** — for targets where npm cannot run at all:

```bash
tar czf ctxmilvus-tree.tgz node_modules package.json

# on the target
mkdir -p /opt/ctxmilvus && tar xzf ctxmilvus-tree.tgz -C /opt/ctxmilvus
/opt/ctxmilvus/node_modules/.bin/codex-context-milvus doctor
```

Use `tar`, not a ZIP tool: the `node_modules/.bin/*` entries are symlinks.

**Repoint Codex at the local copy.** Both methods ship the server, but the config the wizard generates starts it with `npx -y`, which contacts the registry on every Codex launch:

```toml
# <repo>/.codex/config.toml
[mcp_servers.context-milvus]
command = "node"
args = ["/opt/ctxmilvus/node_modules/codex-context-milvus/bin/mcp.js"]
```

`codex mcp add context-milvus -- node /opt/ctxmilvus/node_modules/codex-context-milvus/bin/mcp.js` is the user-level equivalent. Note that `init` always emits the `npx -y` form, so re-running the wizard on an offline box puts the network dependency back.

**What survives the air gap**

- No package in the closure is gated on `os` / `cpu`, so a single bundle serves every platform.
- The 11 `tree-sitter*` packages are ~245 MB unpacked because each one ships N-API prebuilds for `linux` / `darwin` / `win32` × `x64` / `arm64` inside its tarball, and `node-gyp-build` never downloads anything — a bundle built on Linux x64 also runs on an arm64 Mac. To trade that portability for size, keep only the target triple:

  ```bash
  TARGET=linux-arm64   # = node -p 'process.platform+"-"+process.arch' on the target
  find node_modules -mindepth 1 -type d -path '*/prebuilds/*' ! -name "$TARGET" -exec rm -rf {} +
  ```

  Method B only: this is a raw file deletion, while method A's `npm ci` re-checks package contents.

- A platform with no shipped prebuild is the single case that needs a compiler (`python3` + `make` + `g++`) at install time — build the bundle on a matching connected machine rather than compiling on the target.
- The bundle contains the client only. Milvus and the embedding endpoint are services the target must already reach; `doctor` is how you check that.

## Configure

The MCP server reads its settings from environment variables (see the table below), so pick either wiring:

**A. One command, user-level config**

```bash
codex mcp add context-milvus -- npx -y codex-context-milvus mcp
```

**B. Project-level config via the init wizard**

Run inside the repository you want to index:

```bash
npx -y codex-context-milvus init              # interactive (asks on stderr)
npx -y codex-context-milvus init --yes        # non-interactive defaults
npx -y codex-context-milvus init \
  --milvus-address localhost:19530 \
  --embedding-endpoint http://localhost:11434/api/embed \
  --embedding-model nomic-embed-text
```

This writes (or replaces, in place) the `[mcp_servers.context-milvus]` section of `<repo>/.codex/config.toml`, backing the previous file up to `config.toml.bak`. Re-running with the same values is a no-op: nothing is written and no backup is created. Secrets (`MILVUS_TOKEN`, `EMBEDDING_API_KEY`) are **never** written unless you explicitly opt in at the prompt, because `config.toml` is plain text and usually committed.

Generated section:

```toml
[mcp_servers.context-milvus]
command = "npx"
args = ["-y", "codex-context-milvus", "mcp"]
enabled = true

[mcp_servers.context-milvus.env]
MILVUS_ADDRESS = "localhost:19530"
EMBEDDING_ENDPOINT = "http://localhost:11434/api/embed"
EMBEDDING_MODEL = "nomic-embed-text"
CONTEXT_MILVUS_WORKSPACE = "/absolute/path/to/repo"
```

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MILVUS_ADDRESS` | `localhost:19530` | Milvus `host:port` |
| `MILVUS_TOKEN` | *(empty)* | Milvus auth token |
| `MILVUS_COLLECTION` | `code_embeddings` | Collection name |
| `MILVUS_EMBEDDING_DIM` | `768` | Vector dimension — **must match your embedding model** |
| `EMBEDDING_ENDPOINT` | `http://localhost:19530/v2/vectordb/embedding` | OpenAI-compatible embeddings endpoint |
| `EMBEDDING_API_KEY` | *(empty)* | Embedding API key |
| `EMBEDDING_MODEL` | `default` | Embedding model name |
| `HYBRID_MODE` | `true` | BM25 + vector retrieval with RRF fusion |
| `INDEX_EXTENSIONS` | built-in per-language set | Comma-separated extensions to index |
| `INDEX_IGNORE_DIRS` | built-in | Extra directory names to skip |
| `IGNORE_PATTERNS` | built-in | Extra gitignore-style patterns |
| `MERKLE_FILE_PATH` | derived per workspace | Incremental-index state file |
| `CONTEXT_MILVUS_WORKSPACE` | *(unset)* | Pins the workspace root for `doctor` |
| `ADR_ENABLED` | `false` | Registers the 8 ADR decision-memory tools (see below) |
| `ADR_ROOT` | `docs/decisions` | ADR directory, relative to the workspace root |
| `ADR_COLLECTION` | `adr_embeddings` | Milvus collection holding ADR vectors |
| `CONTEXT_MILVUS_ADR_WRITE` | `false` | Allows the ADR tools that write to disk |
| `SPEC_ROOT` | `docs/superpowers/specs` | Directory `index_specs` scans for spec documents |
| `PLAN_ROOT` | `docs/superpowers/plans` | Directory `index_specs` scans for plan documents |

## Tools

| Tool | Arguments | Purpose |
|---|---|---|
| `search_code` | `query`, `topK?`, `path?`, `pathPrefix?` | Natural-language semantic search; returns file path, line range, symbol name, score and the code snippet |
| `index_code` | `mode?` (`incremental`\|`full`), `path?` | Index the repository. Run once before searching; `incremental` afterwards |
| `index_status` | `path?` | Indexed file count, chunk count, last index timestamp |
| `find_callers` | `symbol`, `direction?`, `maxResults?`, `sourceFile?`, `resolve?`, `path?` | Who references this symbol — impact analysis before an edit |
| `trace_call_chain` | `entry`, `direction?`, `maxDepth?`, `maxResults?`, `resolve?`, `path?` | BFS call chain from an entry symbol (`backward` = impact, `forward` = dependencies) |

Every result comes back as both human-readable text and `structuredContent`, so you can consume the JSON directly instead of parsing markdown.

### ADR decision-memory tools

These eight tools are **not registered** unless the server starts with `ADR_ENABLED=true`; MCP has no way to grow the tool list mid-session, so the choice is made once at launch and requires a Codex restart.

| Tool | Arguments | Purpose |
|---|---|---|
| `search_adr` | `query`, `status?`, `topK?`, `pathPrefix?`, `path?` | Semantic search over ADR records — answers *why* the code is the way it is |
| `search_adr_by_file` | `filePath`, `status?`, `path?` | Deterministic lookup of the ADRs that anchor a given code file |
| `list_adrs` | `status?`, `changeType?`, `limit?`, `path?` | List ADR records, filtered by status and change type |
| `load_constraints` | `format?` (`summary`\|`full`), `adrIds?`, `path?` | Active constraints, hidden constraints and rejected anti-patterns |
| `create_adr` | `title`, `requirement?`, `changeType?`, `supersedes?`, `content?`, `path?` | Create an ADR record ⚠️ write |
| `update_adr` | `adrId`, `content?`, `status?`, `supersededBy?`, `merge?`, `path?` | Update constraints, status or body of an existing ADR ⚠️ write |
| `check_adr_consistency` | `filePath?`, `fix?`, `path?` | Report stale `code_anchors` and uncovered changes; only `fix: true` writes |
| `index_specs` | `scanPath?`, `dryRun?`, `path?` | Generate anchors from spec documents and index them; `dryRun` defaults to `true` |

⚠️ **The four tools marked *write* are refused by default.** An autonomous agent must not create documents in your repository by surprise, so they return `E_ADR_WRITE_DISABLED` unless the server was started with `CONTEXT_MILVUS_ADR_WRITE=true`. The gate is checked against the *actual* write intent: `index_specs` with `dryRun: true` and `check_adr_consistency` with `fix: false` (the defaults) stay available without the switch.

An index built by the DSH plugin is reused here unchanged: both adapters resolve the ADR root the same way and share one anchor index and hash tracker under `~/.milvus-index/`.

`search_code` additionally appends a single `相关决策:` line listing the ADRs that cover the returned files — Codex has no hook for injecting constraints, so this is the lightweight reminder instead. When no returned file is covered by an ADR, `search_code` output is byte-identical to a server without ADR support.

### Workspace resolution

Each tool resolves the workspace root in this order:

1. the explicit `path` argument,
2. the nearest ancestor directory containing `.git` (a directory *or* a worktree file),
3. the server's own working directory — which is the Codex session directory.

Merkle state and import maps live under `~/.milvus-index/`, keyed by a hash of the absolute workspace path. An index built by the DSH plugin is therefore reused here unchanged, and vice versa.

## Prerequisites

1. **Milvus** (standalone or zilliz cloud) reachable at `MILVUS_ADDRESS`:

   ```bash
   docker run -d --name milvus -p 19530:19530 -p 9091:9091 milvusdb/milvus:latest standalone
   ```

2. **An OpenAI-compatible embedding endpoint**. Local Ollama works out of the box:

   ```bash
   ollama serve & ollama pull nomic-embed-text
   ```

   `MILVUS_EMBEDDING_DIM` must equal the model's output dimension (768 for `nomic-embed-text`), otherwise the first `index_code` fails with a dimension mismatch.

3. **A first index.** In Codex, ask for `index_status` then `index_code`; on a large repository, run the first full index from a terminal (`npx codex-context-milvus mcp` keeps the tool available) so you do not sit inside a single long tool call.

## Troubleshooting

```bash
npx -y codex-context-milvus doctor      # exit 0 when both probes succeed
```

`doctor` prints the resolved workspace, Milvus and embedding settings, whether a project config exists, then probes the embedding endpoint and Milvus. All server diagnostics go to **stderr** — stdout carries only JSON-RPC, so never redirect stdout to a log expecting diagnostics.

| Error code | Meaning | Fix |
|---|---|---|
| `E_WORKSPACE_NOT_FOUND` | `path` points at something that is not a directory | Pass an absolute path, or omit it to auto-detect |
| `E_MILVUS_UNREACHABLE` | Connection refused / gRPC `UNAVAILABLE` | Start Milvus, check `MILVUS_ADDRESS` |
| `E_EMBEDDING_FAILED` | Embedding endpoint unreachable or rejected the request | Check `EMBEDDING_ENDPOINT`, `EMBEDDING_MODEL`, `EMBEDDING_API_KEY` |
| `E_ADR_WRITE_DISABLED` | A write-capable ADR tool was called with writes switched off | Start the server with `CONTEXT_MILVUS_ADR_WRITE=true`; do not retry |
| `E_ADR_NOT_INITIALIZED` | `ADR_ROOT` points at a directory that does not exist | Create it (or fix `ADR_ROOT`) — the server never creates it for you |
| `E_INTERNAL` | Anything else | Read the server's stderr output |
| `E_COLLECTION_INIT`, `E_EMBEDDING_DIM_MISMATCH`, `E_INDEX_ROOT_UNREADABLE`, `E_IMPORT_MAP_MISSING` | Reserved codes — surfaced today as `E_INTERNAL` with the original message | Planned finer classification |

## Known limitations

- **ADR tools are off by default.** Set `ADR_ENABLED=true` to register them; the server assembles the ADR bundle without touching Milvus, so `tools/list` still works with no database running.
- **No runtime dynamic tool registration.** Toggling features means editing `config.toml` and restarting Codex; there is no settings panel and no hot reload, because the MCP process environment is fixed at launch. This is also why ADR tools appear or disappear at startup rather than at runtime.
- **No constraint / system-prompt injection.** Codex has no hook that can inject into a conversation, so ADR guidance is only a one-line `相关决策:` reminder appended to `search_code` results, plus whatever you put in `AGENTS.md`.
- **Windows is unverified.** `tree-sitter` ships prebuilds for the mainstream platforms; on others the native install may compile from source, and chunking falls back to the regex chunker only for languages that have one.
- **Long indexing calls block the tool call.** A full index of a large repository can take minutes; prefer `mode: "incremental"` inside a session and check progress with `index_status`.
- **MCP Roots are not implemented** — workspace discovery uses the cwd/`.git` rules above instead.
