# dsh-context-milvus

DSH plugin (Cordis) for semantic code search backed by a Milvus vector database. Full documentation, evaluation results and architecture notes live in the [repository README](https://github.com/bobjia/dsh-context-milvus/blob/main/README.md); this file covers the DSH adapter only.

The retrieval engine itself is the separate [`dsh-context-milvus-core`](https://www.npmjs.com/package/dsh-context-milvus-core) package, which this plugin depends on. The same core also powers [`codex-context-milvus`](https://www.npmjs.com/package/codex-context-milvus), an MCP server for OpenAI Codex.

## Registered tools

13 tools, all unchanged since 0.6.x:

- Retrieval: `search_code`, `index_code`, `index_status`
- Code relations: `find_callers`, `trace_call_chain`
- ADR decision memory: `search_adr`, `search_adr_by_file`, `create_adr`, `update_adr`, `list_adrs`, `load_constraints`, `check_adr_consistency`, `index_specs`

On a large workspace `index_code` / `index_specs` only scan and tell you to run
`dsh-context-milvus-index` (the script shipped with this package) in a terminal; see
"Standalone Index Script" in the root README.

The tool names, their parameters and the `Config` fields are covered by a freeze test (`test/public-surface.spec.ts`), so they are a stable public contract.

## Install into a DSH Web profile

Requires **DSH ≥ 0.1.7-rc.2**. 0.1.7 replaced the settings plugin API on both
halves — the host's `installSection()` and the client's `settingsScope` service
are gone — and the config schema now relies on schemastery's `.volatile()`,
which older harnesses do not ship. There is no compatibility mode: on an older
harness the plugin cannot load.

```bash
cd ~/.dsh/profiles/web
pnpm add file:/path/to/dsh-context-milvus     # or: pnpm add dsh-context-milvus
```

Then add `"dsh-context-milvus"` to `dsh.profile.bundles` in `~/.dsh/profiles/web/package.json`. Bundle wiring is applied through the package's `cordis.patch.yml`; `cordis-entry.yml` in this package is a commented configuration example, not an active bundle.

## Configuration

After installing, the plugin appears under **Settings → Plugins** in the DSH Web UI, with a form per field (secret fields such as `milvusToken` / `embeddingApiKey` render as password inputs, booleans as switches).

Every field is declared `.volatile()`, which is what makes it appear in — and writable from — that form: dsh-settings ≥0.1.7 lists a plugin's settings section only when its schema has volatile fields, and refuses writes to any field that is not. Committed edits are delivered to the running plugin as a `loader/volatile-update` event and take effect without a reload (services that are baked in at construction — Milvus/embedding connection fields — are rebuilt).

Resolution order is **plugin config → environment variables → defaults**. Every field has an env fallback: `MILVUS_ADDRESS`, `MILVUS_TOKEN`, `MILVUS_COLLECTION`, `MILVUS_EMBEDDING_DIM`, `EMBEDDING_ENDPOINT`, `EMBEDDING_API_KEY`, `EMBEDDING_MODEL`, `INDEX_ROOT`, `INDEX_EXTENSIONS`, `HYBRID_MODE`, `INDEX_IGNORE_DIRS`, `IGNORE_PATTERNS`, `MERKLE_FILE_PATH`, `QUERY_EXPANSION`, `RERANK_ENABLED`, `SPEC_ROOT`, `PLAN_ROOT` (see `packages/core/src/config.ts` for the authoritative mapping).

ADR features are off by default; enable `adrEnabled` and keep decision records in `docs/decisions/` (or set `adrRoot`).

## Workspace behaviour

Each DSH session's workspace is auto-detected, and Merkle state plus import maps are stored per workspace under `~/.milvus-index/`, keyed by the absolute workspace path — so an index built here is reusable by the MCP server for the same repository.

## License

MIT
