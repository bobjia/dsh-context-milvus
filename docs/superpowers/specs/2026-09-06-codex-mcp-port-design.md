---
title: codex-mcp-port
type: spec
created: 2026-09-06
status: draft
id: SPEC-2026-09-06-codex-mcp-port
related_decisions: []
---

# Codex MCP 移植（dsh-context-milvus → Codex）

## 概要

把 `dsh-context-milvus` 的代码检索内核（Milvus 向量库 + AST 分块 + 增量索引 + 代码关系分析）移植到 OpenAI Codex CLI。第一版以 **独立 Codex 包 + MCP Server + 项目级配置向导 + Codex Plugin 清单** 的形态交付，不追求与 DSH 插件 100% 行为等价。

## 背景与约束

已通过本机 `codex-cli 0.147.0` 实测确认 Codex 的扩展模型：

- **MCP Servers**（`[mcp_servers.*]`，stdio 或 streamable HTTP）是暴露自定义工具的唯一进程内能力入口。
- **Plugins / Marketplace** 是分发包形态，插件包可包含 `skills/`、`.mcp.json`、`.codex-plugin/plugin.json`、`hooks.json`，但**不能让任意 Node.js 代码直接进驻 Agent 进程**。
- **Skills** 提供触发式工作流说明；**Hooks** 是外部命令（`SessionStart`、`PostToolUse`、`UserPromptSubmit` 等），不是进程内中间件。
- DSH 侧的 `ctx.tools.register()`、`defineTool()`、`ctx.settings`、`systemPrompt` 服务、`agent/pre-step`、`tools/result`、`createUserMessage()` 在 Codex 中**没有一一对应物**。

因此本移植的核心工作是：**抽取框架无关内核 → 实现 MCP 适配器 → 用 Skill/配置/插件清单补齐体验**。

## 第一版目标

1. 保持根目录 DSH 包 `dsh-context-milvus` 的包名、入口、配置字段、工具名与行为不变。
2. 新增独立包 `codex-context-milvus`，提供 stdio MCP Server。
3. 代码检索内核单份维护，DSH 与 Codex 两个适配器共享，杜绝双份漂移。
4. 提供交互式 `init` 配置向导，把 MCP 配置写入项目级 `.codex/config.toml`。
5. 随包提供 `.codex-plugin/plugin.json` 与 `.mcp.json`，为后续 Marketplace 分发做准备。
6. 第一版 MCP 工具与 DSH 主工具同名同参：`search_code`、`index_code`、`index_status`、`find_callers`、`trace_call_chain`。

## 非目标（第一版不实现）

- ADR 决策记忆（8 个 ADR 工具、约束注入、一致性检查）—— 后续独立 spec。
- DSH Web GUI 设置面板及其 `client/client.js` React 组件。
- DSH 式系统提示注入与 `agent/pre-step` 消息插入。
- 自动 ADR 约束重注入。
- Codex Marketplace 发布流程与 `marketplace.json` 验证。
- MCP Roots 协议接入。
- streamable HTTP 传输（仅 stdio）。
- 索引结果的远程/多机共享。

## 方案选择

采用 **方案 B：同仓库 npm workspaces + 共享 core + 双入口**。

被否决的方案：

- **方案 A：独立包内复制核心** —— 核心算法双份维护，DSH 与 Codex 检索结果容易漂移。
- **方案 C：先独立发布 core 包再新建 Codex 仓库** —— 发布链路更重，早期迭代慢，收益不足。

## 架构

### 仓库结构

根目录由现有 DSH 包改造为私有 npm workspace：

```text
dsh-context-milvus/            # workspace root，private: true
  package.json                 # workspaces: ["packages/*"]
  tsconfig.base.json
  packages/
    core/                      # 框架无关内核
      package.json             # name: @dsh-context-milvus/core（私有 workspace 名）
      src/
        config.ts              # getConfig / deriveMerkleFilePath / DEFAULT_*
        types.ts
        embedding.ts
        milvus-service.ts
        chunker.ts
        indexer.ts
        merkle.ts
        ignore-matcher.ts
        import-resolver.ts
        code-relations.ts
        query-expansion.ts
        reranker.ts
        telemetry.ts
        logger.ts              # 新增：统一日志抽象
    dsh/                       # 现有 DSH 包
      package.json             # name: dsh-context-milvus（不变）
      cordis-entry.yml
      cordis.patch.yml
      client/client.js
      src/
        index.ts
        tools.ts
        adr-*.ts               # ADR 暂时留在 DSH 包，后续再评估下沉
        constraint-injector.ts
    codex/                     # 新增 Codex 包
      package.json             # name: codex-context-milvus
      bin/
        mcp.js                 # MCP Server 入口
        cli.js                 # init / doctor
      src/
        server.ts
        workspace-resolver.ts
        context.ts
        handlers.ts
        schemas.ts
        result-format.ts
        init-wizard.ts
        workspace-services.ts
      .codex-plugin/plugin.json
      .mcp.json
      skills/context-milvus/SKILL.md
```

### core 包

**职责**：纯领域逻辑，不依赖 `@deepseek-ai/*`，也不依赖 MCP SDK。对外只暴露类、函数和纯类型。

**依赖允许清单**：`@zilliz/milvus2-sdk-node`、`tree-sitter*`、`ignore`、`js-yaml`、Node 内置模块。

**日志约束**：core 内不得直接调用 `console.log`。core 暴露 `Logger` 接口，由适配器注入：

```ts
export interface Logger {
  debug(msg: string, meta?: unknown): void
  info(msg: string, meta?: unknown): void
  warn(msg: string, meta?: unknown): void
  error(msg: string, meta?: unknown): void
}
```

DSH 适配器注入普通 console logger；Codex MCP 适配器注入 **stderr-only** logger（stdout 属于 JSON-RPC）。

### dsh 包

`name`、`main`、`types`、`cordis-entry.yml`、`cordis.patch.yml`、`client/client.js`、`Config` schema、13 个工具名与参数全部保持不变。仅把可复用逻辑的 import 从本地相对路径改为 `@dsh-context-milvus/core`，并注入默认 Logger。ADR 相关模块第一版留在 DSH 包内。

### codex 包

只做适配，不含核心逻辑：

| 模块 | 职责 |
|---|---|
| `bin/mcp.js` | 可执行入口，启动 stdio MCP Server |
| `bin/cli.js` | `codex-context-milvus init` / `doctor` |
| `src/server.ts` | 注册 5 个 MCP 工具，绑定 handler |
| `src/workspace-resolver.ts` | 工作区根目录发现 |
| `src/context.ts` | 每次调用的 `RuntimeContext`（workspaceRoot、logger、config） |
| `src/handlers.ts` | 复用逻辑的调用编排（从 DSH `tools.ts` 抽出，去除 `exec` 依赖） |
| `src/schemas.ts` | 5 个工具的 MCP JSON Schema |
| `src/result-format.ts` | 结构化 JSON + Markdown 文本渲染 |
| `src/workspace-services.ts` | 按 workspaceRoot 缓存 `MilvusService` / `HashTracker` / `ImportResolver` |
| `src/init-wizard.ts` | 交互式配置向导 |

### 构建与发布

- `packages/core` 发布为**无 scope 的公开 npm 包** `dsh-context-milvus-core`，避免申请 org scope，也避免用打包内联时 `.d.ts` 指向不存在模块的问题。
- `packages/dsh` 的构建**保持 `tsc` 不变**（`main: dist/plugins/dsh-context-milvus/index.js`、`types: dist/.../index.d.ts`），只把本地相对引用改为依赖 `dsh-context-milvus-core`。发布形态与加载方式零回归。
- `packages/codex` 同样用 `tsc` 构建，`bin` 指向 `dist/mcp.js` 与 `dist/cli.js`，保证 `npx -y codex-context-milvus mcp` 可用。
- 依赖关系：`packages/{dsh,codex}` 的 `dependencies` 含 `dsh-context-milvus-core`（版本用 `^` 范围）；仓库内 Jest 通过 `moduleNameMapper` 把该包名映射到 `packages/core/src/index.ts`，测试无需先构建 core。
- `tree-sitter*`、`@zilliz/milvus2-sdk-node` 等原生/大体积依赖保留在两个适配器包各自的 `dependencies`，由包管理器按平台解析原生二进制。
- 发布三个 npm 包：`dsh-context-milvus`（既有）、`codex-context-milvus`（新）、`dsh-context-milvus-core`（新）；三包版本独立，`dsh-context-milvus` 历史版本号继续递增。

## 工作区解析

### 接口

```ts
export interface WorkspaceResolution {
  root: string
  source: 'explicit' | 'git' | 'cwd'
}

export function resolveWorkspaceRoot(
  explicitPath?: string,
  cwd?: string,
): WorkspaceResolution
```

### 解析规则（按顺序）

1. **显式 `path` 参数**（工具调用或 CLI 传入）→ `source: 'explicit'`；必须存在且为目录，否则业务错误。
2. **从 `cwd` 向上逐级查找 `.git` 目录或文件** → 找到的第一层目录为根 → `source: 'git'`。同时兼容 `.git` 为文件的情况（git worktree / submodule）。
3. **找不到 `.git`** → 使用 `cwd` 本身 → `source: 'cwd'`。

### 约束与已知边界

- 第一版不接入 MCP Roots，不把 `INDEX_ROOT` 作为隐式项目定位入口（仅作为连接与默认配置来源）。
- MCP Server 由 Codex 从插件缓存目录启动时，步骤 2 可能无法命中用户项目；此时步骤 3 会退化为插件目录。**这是已知限制**，通过两条路径缓解：模型显式传 `path`；`init` 向导在项目 `.codex/config.toml` 中写入 `args = ["...", "--workspace", "/abs/path"]` 或 env `CONTEXT_MILVUS_WORKSPACE`。
- 第一版不强制 git 存在，以保证非 Git 目录可用。

### 状态文件隔离

- Milvus collection 跨工作区共享，工具调用通过 `file_path` 前缀过滤限定到当前 `workspaceRoot`。
- Merkle 状态文件继续沿用 `deriveMerkleFilePath(root)` 的按 root 哈希命名方案。
- Import map 沿用 `deriveImportMapFilePath(root)`。
- 多进程并发索引的加锁不在第一版范围，但在错误码与文档中标注风险。

## 配置

### 环境变量（复用 core 既有解析）

| 变量 | 默认值 | 用途 |
|---|---|---|
| `MILVUS_ADDRESS` | `localhost:19530` | Milvus 地址 |
| `MILVUS_TOKEN` | 空 | Milvus 鉴权 |
| `MILVUS_COLLECTION` | `code_embeddings` | 代码集合名 |
| `MILVUS_EMBEDDING_DIM` | `768` | 向量维度 |
| `EMBEDDING_ENDPOINT` | `http://localhost:11434/api/embed` | Embedding API |
| `EMBEDDING_API_KEY` | 空 | Embedding 密钥 |
| `EMBEDDING_MODEL` | `nomic-embed-text` | Embedding 模型 |
| `INDEX_ROOT` | 进程 cwd | 默认索引根 |
| `INDEX_EXTENSIONS` | 全部支持后缀 | 索引后缀 |
| `HYBRID_MODE` | `true` | BM25 + 向量混合检索 |
| `CHUNK_CONTEXT_LINES` | `2` | 分块上下文行数 |
| `QUERY_EXPANSION` | `true` | 查询扩展 |
| `RERANK_ENABLED` | `true` | 两阶段重排序 |
| `CONTEXT_MILVUS_WORKSPACE` | 空 | 显式工作区（向导写入的项目级覆盖） |

连接类配置只从环境变量读取；第一版不为 Milvus/Embedding 增加专用配置文件解析。

### 密钥处理

- `init` 向导**默认不写入** `MILVUS_TOKEN` 与 `EMBEDDING_API_KEY`。
- 仅当用户显式确认时才写入项目 `.codex/config.toml`。
- 文档明确提示：项目配置可能被提交到 Git，敏感 key 建议改用 shell 环境变量或 `--env` 注入。

## 配置向导（init）

### 交互流程

1. 解析当前项目根（复用 `resolveWorkspaceRoot`）。
2. 探测 `.codex/config.toml` 是否存在：
   - 不存在 → 计划创建；
   - 存在 → 读取，检测是否已有 `mcp_servers.context-milvus`。
3. 询问 Milvus 地址（默认 `localhost:19530`）。
4. 询问 Embedding endpoint 与 model（默认 Ollama `nomic-embed-text`）。
5. 询问是否写入密钥（默认否）。
6. 打印将要写入的 TOML 片段并请求确认。
7. 写入前备份为 `config.toml.bak`（若原文件存在）。
8. 写入或更新 `[mcp_servers.context-milvus]`：仅改动该 section，保留其它内容与注释。

### 非交互模式（CI）

```bash
codex-context-milvus init --yes --non-interactive \
  --milvus-address localhost:19530 \
  --embedding-endpoint http://localhost:11434/api/embed \
  --embedding-model nomic-embed-text
```

### 写入示例

```toml
[mcp_servers.context-milvus]
command = "npx"
args = ["-y", "codex-context-milvus", "mcp"]
enabled = true

[mcp_servers.context-milvus.env]
MILVUS_ADDRESS = "localhost:19530"
MILVUS_COLLECTION = "code_embeddings"
MILVUS_EMBEDDING_DIM = "768"
EMBEDDING_ENDPOINT = "http://localhost:11434/api/embed"
EMBEDDING_MODEL = "nomic-embed-text"
CONTEXT_MILVUS_WORKSPACE = "/abs/path/to/project"
```

向导只写项目级 `.codex/config.toml`，第一版不修改用户全局 `~/.codex/config.toml`。

## MCP Server

- 命令：`codex-context-milvus mcp`；传输：stdio。
- 进程内按 `workspaceRoot` 缓存 `WorkspaceServices`：

```ts
interface WorkspaceServices {
  milvus: MilvusService
  tracker: HashTracker
  importResolver: ImportResolver
}
```

- Milvus 连接与 collection 初始化保持懒惰，首次工具调用才建立。
- 服务按需创建，避免启动即连接 Milvus 导致 Codex 启动变慢或 MCP 握手失败。

## MCP 工具契约

### search_code

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `query` | string | 是 | — | 自然语言查询 |
| `topK` | number | 否 | 5 | 返回结果数 |
| `path` | string | 否 | 自动解析 | 工作区根目录 |
| `pathPrefix` | string | 否 | — | 限定子目录（相对根） |

`pathPrefix` 为第一版新增的 Codex 专属子目录过滤参数，避免与 DSH 既有 `path` 语义冲突。

### index_code

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `mode` | enum(`full`,`incremental`) | 否 | `incremental` | 索引模式 |
| `path` | string | 否 | 自动解析 | 工作区根目录 |

### index_status

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `path` | string | 否 | 自动解析 | 工作区根目录 |

### find_callers

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `symbol` | string | 是 | — | 符号名 |
| `direction` | enum(`backward`,`forward`) | 否 | `backward` | 影响面 / 依赖面 |
| `maxResults` | number | 否 | 20 | 最大结果数 |
| `sourceFile` | string | 否 | — | 限定定义文件 |
| `resolve` | boolean | 否 | true | 启用 import 解析 |
| `path` | string | 否 | 自动解析 | 工作区根目录 |

### trace_call_chain

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `entry` | string | 是 | — | 入口符号 |
| `direction` | enum(`backward`,`forward`) | 否 | `backward` | 展开方向 |
| `maxDepth` | number | 否 | 3 | 最大深度 |
| `maxResults` | number | 否 | 10 | 每层最大结果数 |
| `resolve` | boolean | 否 | true | 启用 import 解析 |
| `path` | string | 否 | 自动解析 | 工作区根目录 |

## 返回格式

所有工具统一返回 MCP `tools/call` 结果：**结构化 JSON + Markdown 文本双通道**。

每个工具声明 `outputSchema`，并在成功响应中同时返回：

```jsonc
{
  "content": [
    { "type": "text", "text": "<Markdown 渲染，供模型阅读>" }
  ],
  "structuredContent": { /* 与 outputSchema 一致的机器可读结构 */ },
  "isError": false
}
```

- `text` 通道始终存在，作为不支持 `structuredContent` 的客户端的兼容回退，也是模型的主要阅读路径。
- `structuredContent` 承载完整结果数组或结果对象，便于自动化断言与后续工具组合。
- 两个通道必须由同一份结果对象渲染，禁止各自独立拼装，避免语义漂移。
- 错误响应只使用 `content` + `isError: true`，不返回 `structuredContent`。

### 向量检索结果渲染

```markdown
[结果 1] 文件: src/config.ts (typescript), 第 12-40 行 「parseConfig」
相关度: 0.8731
类型: function_declaration
内容:
```typescript
...
```
```

### 错误处理

业务错误（路径不存在、Milvus 不可达、Embedding 失败）返回：

```jsonc
{
  "content": [{ "type": "text", "text": "错误 [E_MILVUS_UNREACHABLE]: 无法连接 Milvus localhost:19530。\n建议：确认 Milvus 已启动，或在 .codex/config.toml 中修改 MILVUS_ADDRESS。" }],
  "isError": true
}
```

错误信息必须包含稳定错误码与可执行的修复建议；**不得**回显 `MILVUS_TOKEN`、`EMBEDDING_API_KEY` 等敏感值。正常检索结果可以包含代码正文。

## 错误码

| 错误码 | 场景 | 建议 |
|---|---|---|
| `E_WORKSPACE_NOT_FOUND` | 显式 path 不存在或不是目录 | 检查路径，或省略 path 让工具自动发现 |
| `E_MILVUS_UNREACHABLE` | 无法连接 Milvus | 确认 Milvus 已启动并检查 `MILVUS_ADDRESS` |
| `E_COLLECTION_INIT` | collection 创建/校验失败 | 检查 Milvus 版本与权限，查看 server 日志 |
| `E_EMBEDDING_FAILED` | Embedding API 调用失败 | 检查 `EMBEDDING_ENDPOINT`、model 与网络 |
| `E_EMBEDDING_DIM_MISMATCH` | 返回向量维度与 `MILVUS_EMBEDDING_DIM` 不一致 | 对齐模型维度与配置 |
| `E_INDEX_ROOT_UNREADABLE` | 索引根不可读 | 检查目录权限 |
| `E_IMPORT_MAP_MISSING` | import map 不存在 | 警告并降级为名称匹配；运行 `index_code` 后恢复精确匹配 |
| `E_INTERNAL` | 未分类异常 | 查看 Codex MCP server stderr 日志 |

## 数据流

### 索引

```text
index_code(path?)
  → resolveWorkspaceRoot(path)
  → workspaceServices(root)
  → runIndex(configForRoot, milvus, tracker, { mode, logger })
  → Milvus upsert + Merkle 状态落盘
  → Markdown 摘要返回
```

### 检索

```text
search_code(query, topK, path?, pathPrefix?)
  → resolveWorkspaceRoot(path)
  → milvus.ensureCollection()
  → milvus.search(query, topK, root, pathPrefix)
  → 结果过滤到 root 前缀
  → Markdown 渲染
```

### 代码关系

```text
find_callers / trace_call_chain(symbol, path?)
  → resolveWorkspaceRoot(path)
  → importResolver 已加载？是则精确解析，否则降级名称匹配并附警告
  → 返回结果与 resolution 标注
```

## 日志与进程契约

- MCP stdio 下 **stdout 只允许 JSON-RPC**。
- core 通过注入 Logger 输出；Codex 适配器实现 stderr-only logger。
- 任何业务日志写入 stdout 视为 P0 缺陷，必须有测试守护。
- `bin/mcp.js` 在启动早期安装 `process.on('uncaughtException')` / `unhandledRejection` 处理器，输出到 stderr 并保持协议完整性。

## 迁移步骤

1. **Workspace 骨架**：根 `package.json` 改 private + workspaces；新增 `tsconfig.base.json`；`packages/{core,dsh,codex}` 骨架与构建脚本。
2. **core 抽取**：迁移 12 个框架无关模块与对应单测；引入并注入 `Logger`；确认 core 不 import 任何 `@deepseek-ai/*`。
3. **DSH 适配器改造**：`packages/dsh` 指向 core；`index.ts` / `tools.ts` / `adr-tools.ts` / `constraint-injector.ts` 改为消费 core；确保 13 个工具、配置字段、包名与行为不变。
4. **Codex MCP 适配器**：实现 resolver、context、workspace-services、handlers、schemas、result-format、server；暴露 5 个工具。
5. **init 与插件文件**：实现 `init` / `doctor`；提供 `.codex-plugin/plugin.json`、`.mcp.json`、`skills/context-milvus/SKILL.md`。
6. **验证与发布准备**：全量单测、DSH 回归、适配器测试、MCP stdio E2E、README 更新、npm 包名核对。

## 测试策略

### core 单测（沿用现有 Jest 套件）

覆盖：config 解析优先级、HashTracker CRUD/持久化、Embedding 各响应格式、Milvus collection/search/insert/delete、chunker 多语言、ignore matcher 三层规则、import resolver、code relations、reranker、query expansion、ADR 相关模块。

### DSH 回归

- 现有 13 个工具名与参数 schema 不得变化；
- `cordis-entry.yml` / `cordis.patch.yml` / `client/client.js` 行为不变；
- settings schema 字段不变；
- 现有 DSH 测试全部通过。

### Codex 适配器测试

- `resolveWorkspaceRoot`：explicit / .git 命中 / .git 为文件 / 无 git 回退 cwd / 路径不存在报错；
- 结果格式：5 个工具的成功与错误渲染；
- logger 注入：断言测试期间 stdout 无业务输出；
- schemas：必填与默认值符合契约。

### E2E

- 使用 MCP stdio 客户端启动 `bin/mcp.js`，完成 initialize → tools/list → tools/call；
- 对样例仓库执行 `index_code` → `search_code` → `find_callers`；
- Milvus 与 Embedding 在 CI 中使用 mock / testcontainers；真实 Milvus 冒烟为发版前手动验证。

## 验收标准

1. `npm test` 全绿（core + dsh + codex）。
2. 根 workspace 构建通过，`packages/codex` 可 `npm pack` 并产出可执行 bin。
3. `codex mcp add context-milvus -- ...` 后，Codex 能列出 5 个工具。
4. `index_code` 可索引样例仓库，`index_status` 返回文件数与最后索引时间。
5. `search_code` 返回相关片段，重复调用结果稳定。
6. `find_callers` / `trace_call_chain` 在 import map 存在时给出 `resolved` 标注，缺失时降级并附警告。
7. `init` 向导可写出项目 `.codex/config.toml`，且不破坏既有 section。
8. DSH 包发布形态与配置字段保持向后兼容。
9. 整个 MCP 会话 stdout 无业务日志污染。

## 后续扩展（不在本 spec 范围）

- ADR 工具与决策记忆的 Codex 适配。
- `SessionStart` / `PostToolUse` / `UserPromptSubmit` hooks（咨询式约束注入）。
- Codex Marketplace 发布与 `marketplace.json`。
- MCP Roots 接入与更智能的项目发现。
- streamable HTTP 传输。
- Windows 下的 tree-sitter 原生依赖验证。
- 原生 TypeScript/JavaScript 之外语言的树解析扩展。
- 多进程索引加锁。
