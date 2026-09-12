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

## Tools

| Tool | Arguments | Purpose |
|---|---|---|
| `search_code` | `query`, `topK?`, `path?`, `pathPrefix?` | Natural-language semantic search; returns file path, line range, symbol name, score and the code snippet |
| `index_code` | `mode?` (`incremental`\|`full`), `path?` | Index the repository. Run once before searching; `incremental` afterwards |
| `index_status` | `path?` | Indexed file count, chunk count, last index timestamp |
| `find_callers` | `symbol`, `direction?`, `maxResults?`, `sourceFile?`, `resolve?`, `path?` | Who references this symbol — impact analysis before an edit |
| `trace_call_chain` | `entry`, `direction?`, `maxDepth?`, `maxResults?`, `resolve?`, `path?` | BFS call chain from an entry symbol (`backward` = impact, `forward` = dependencies) |

Every result comes back as both human-readable text and `structuredContent`, so you can consume the JSON directly instead of parsing markdown.

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
| `E_INTERNAL` | Anything else | Read the server's stderr output |
| `E_COLLECTION_INIT`, `E_EMBEDDING_DIM_MISMATCH`, `E_INDEX_ROOT_UNREADABLE`, `E_IMPORT_MAP_MISSING` | Reserved codes — surfaced today as `E_INTERNAL` with the original message | Planned finer classification |

## Known limitations

- **No ADR decision-memory tools.** The 8 ADR tools exist only in the DSH plugin; the MCP surface is deliberately limited to the 5 retrieval tools.
- **No runtime dynamic tool registration.** Toggling features means editing `config.toml` and restarting Codex; there is no settings panel and no hot reload, because the MCP process environment is fixed at launch.
- **No constraint / system-prompt injection.** Codex has no hook that can inject into a conversation, so ADR-style guidance can only be static (`AGENTS.md`).
- **Windows is unverified.** `tree-sitter` ships prebuilds for the mainstream platforms; on others the native install may compile from source, and chunking falls back to the regex chunker only for languages that have one.
- **Long indexing calls block the tool call.** A full index of a large repository can take minutes; prefer `mode: "incremental"` inside a session and check progress with `index_status`.
- **MCP Roots are not implemented** — workspace discovery uses the cwd/`.git` rules above instead.
