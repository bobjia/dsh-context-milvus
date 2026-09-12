# 可行性分析：将 dsh-context-milvus 移植为 Codex 插件

> 日期：2026-02
> 状态：分析稿（未实施）
> 说明：分析时本环境网络受限，Codex CLI 的机制描述基于既有知识；文中标注 ⚠️ 的条目属版本相关特性，实施前需针对锁定的 Codex 版本复核（`codex --version`、`docs/config.md`、`codex mcp --help`）。

---

## 1. 结论摘要（TL;DR）

**可行，风险低，工作量中等（约 1～1.5 人周）。**

关键前提认知：**OpenAI Codex CLI 没有 Cordis 意义上的"插件框架"**（无 DI 容器、无运行时工具注册/注销、无设置面板 API）。它的官方扩展面只有四个：

1. **MCP 客户端**：`~/.codex/config.toml` 中 `[mcp_servers.*]` 声明 stdio MCP server，其工具自动暴露给模型（`codex mcp add` 可代写配置）；
2. **AGENTS.md**：全局 + 目录级指令注入，等价于静态系统提示；
3. **Custom prompts**：`~/.codex/prompts/*.md` → 斜杠命令；
4. **notify 钩子**：向外部程序广播回合事件（只读旁路，不能修改对话）。

因此"移植为 Codex 插件"的正确形态是：**把本工程改造为一个 MCP (stdio) server，配 AGENTS.md 模板分发**。这不是降级——MCP 是行业公共标准，同一份 server 可同时服务 Codex、Claude Code、Cursor、Windsurf 等所有 MCP 客户端，反而扩大适用面。

代码层面：全库约 6,644 行，其中 **约 72%（≈4,800 行核心引擎）零改动复用**；需要重写的只是最外层的"工具声明与注册"胶水层（约 1,300 行中真正耦合的不足一半）；真正的硬缺口只有一处——**ADR 约束注入的生命周期钩子在 Codex 中无等价物，只能降级补偿**（见 §6）。

---

## 2. 现状：耦合点盘点

对 `src/plugins/dsh-context-milvus/` 全量扫描，依赖 `@deepseek-ai/*`（cordis / dsh-tools / dsh-llm / dsh-settings / schemastery）的文件**只有 4 个**：

| 文件 | 行数 | 耦合内容 | 移植处理 |
|---|---|---|---|
| `index.ts` | 328 | Cordis 入口 `apply(ctx)`、schemastery Config schema、`ctx.settings.installSection` 设置面板 | 重写为 MCP server 启动器（bootstrap 逻辑可抄） |
| `tools.ts` | 701 | `defineTool()` + `ctx.tools.register()`（5 个工具）；`exec.agent.session.header.cwd` 取工作区 | 声明层机械转换；execute 体内的业务逻辑原样保留 |
| `adr-tools.ts` | 588 | 同上（8 个工具） | 同上 |
| `constraint-injector.ts` | 227 | `systemPrompt.section/context`、`agent/pre-step` 中间件、`tools/result` 钩子、`createUserMessage` 注入 | **无等价物，需降级方案**（§6） |

其余 **20 个模块约 4,800 行完全不感知 DSH 框架**，包括：

- 检索引擎：`milvus-service.ts`（715）、`chunker.ts`（759）、`indexer.ts`、`embedding.ts`、`reranker.ts`、`query-expansion.ts`、`import-resolver.ts`（490）、`code-relations.ts`
- 增量/忽略体系：`merkle.ts`、`ignore-matcher.ts`
- ADR 引擎：`adr-service.ts`、`adr-indexer.ts`、`adr-chunker.ts`、`adr-frontmatter.ts`、`adr-anchor-index.ts`、`adr-anchor-generator.ts`
- 配置：`config.ts`（271）——**关键利好**：`getConfig()` 早已实现 `overrides > 环境变量 > 默认值` 三级解析，而 Codex 的 MCP server 配置恰好就是 `env = {...}`，配置链路几乎零改造
- 遥测：`telemetry.ts`（纯 fs 写入）

工作区自动检测也有天然替代：现在的三级兜底是 `显式 path 参数 → exec.agent.session.header.cwd → config.indexRoot → process.cwd()`。**Codex 以会话启动目录为 cwd 拉起 MCP server**，`process.cwd()` 直接就是会话工作区，`deriveMerkleFilePath()` 的多工作区隔离逻辑原样可用。

---

## 3. 能力映射表：DSH 特性 → Codex 对应物

| DSH 机制 | Codex 对应物 | 差距 |
|---|---|---|
| `ctx.tools.register(defineTool)` | MCP `tools/list` + `tools/call`（JSON Schema） | 无实质差距。DSH `parameters` 本身就是 JSON-Schema 风格（type/required/description），机械转换 |
| 工具 `output.schema` + render 函数 | MCP `CallToolResult.content[].text`（render 函数直接复用产出的 markdown） | 无差距 |
| 运行时注册/注销 ADR 工具（`toggleAdr`） | 无运行时动态性；改 config.toml 后重启 Codex 生效 | 小差距。可用**双 server**（code 组 / adr 组）或 server 启动时按 env 开关决定是否 `list` 出 ADR 工具来补偿 |
| 设置面板热更新（`setSource` thunk） | `config.toml` `[mcp_servers.*].env` | 无热更新；改配置需重启。MCP server 每次工具调用时 `getConfig()` 重读 env 也拿不到新值（进程环境已固化） |
| 工作区检测 `exec.agent.session.header.cwd` | `process.cwd()`（Codex 以会话 cwd 拉起 server） | 无差距 |
| `systemPrompt.section`（ADR 规则注入） | AGENTS.md（静态） | ⚠️ 中等差距，见 §6-1 |
| `systemPrompt.context`（active ADR 摘要动态注入） | 无动态注入通道 | 中等差距，见 §6-1 |
| `agent/pre-step` 约束重注入 | 无回合中间件；`notify` 只读旁路改不了对话 | 无法等价，见 §6-2 |
| `tools/result` 监听 write/edit 触碰 ADR 覆盖文件 | 无工具结果中间件。⚠️ 新版 Codex 实验性 hooks 是否覆盖待验证 | 无法等价，见 §6-3 |
| Web GUI 配置面板（`client/`） | 无 GUI 宿主 | 放弃；由 AGENTS.md + config.toml 文档替代 |

---

## 4. 移植后的形态草图

```
codex-mcp/
├── src/
│   ├── core/          ← 现有 20 个框架无关模块整体平移（零改动）
│   ├── mcp/
│   │   ├── server.ts  ← 替代 index.ts：读 env → bootstrap 服务 → 注册 MCP tools
│   │   ├── tools.ts   ← 替代 tools.ts/adr-tools.ts 的声明层（execute 逻辑平移）
│   │   └── schema.ts  ← 参数 schema 直接复用现有 JSON-Schema 风格定义
│   └── plugins/dsh-context-milvus/  ← DSH 适配器保留（双前端共存）
├── templates/AGENTS.md   ← ADR 规则段模板（替代 constraint-injector §1）
└── package.json          ← 新增 @modelcontextprotocol/sdk
```

Codex 侧接入（`~/.codex/config.toml` 或项目级 `.codex/config.toml`）：

```toml
[mcp_servers.dsh-context]
command = "npx"
args = ["-y", "dsh-context-mcp"]        # 或 node /abs/path/dist/mcp/server.js
env = { MILVUS_ADDRESS = "localhost:19530",
        EMBEDDING_ENDPOINT = "http://localhost:11434/api/embed",
        HYBRID_MODE = "true" }
startup_timeout_sec = 15
```

---

## 5. 工作量分解

| 阶段 | 内容 | 估计 |
|---|---|---|
| P1 核心链路 | MCP stdio server 壳；`search_code` / `index_code` / `index_status` 3 个工具；env 配置链路验证；`process.cwd()` 工作区检测 | 1～2 天 |
| P2 完整工具面 | 其余 14 个工具（`find_callers`、`trace_call_chain`、8 个 ADR 工具、`index_specs`）；ADR 开关改为启动时 env 判定 | 1～2 天 |
| P3 约束注入补偿 | AGENTS.md 模板 + `dsh-context install-agents` 之类的生成命令；文档；Codex 版本相关特性复核（⚠️ hooks / MCP prompts） | 2～3 天 |
| 回归 | 现有 jest 套件（mock 的是模块而非框架）基本可直接跑在 core 上；补 MCP 协议层冒烟测试 | 0.5～1 天 |

合计 ≈ **5～8 人日**。P3 是唯一有不确定性的部分（取决于愿意接受多强的降级）。

---

## 6. 硬缺口与降级方案（constraint-injector 三件事）

### 6-1. 系统提示注入（ADR 规则 + active 约束摘要）

- **降级方案（推荐）**：把 `DEFAULT_SYSTEM_PROMPT`（现成文本）做成 AGENTS.md 片段模板，安装命令写入项目 `AGENTS.md`。规则部分本来就是静态的，覆盖 90% 效果。
- active ADR 摘要（`buildConstraintSummary`）无法动态注入 → 在 AGENTS.md 里指示"修改代码前先调 `load_constraints`/`search_adr_by_file`"，把被动注入变成主动工具调用。
- ⚠️ 可探索：Codex 对 MCP `prompts` 资源的支持程度——若支持，可暴露一个 `decision-memory` prompt 供 `/` 调用手动注入。

### 6-2. 每 N 步约束重注入（防长对话遗忘）

- **无等价机制**。Codex 的 `notify` 钩子只做事件广播，无法向对话插入消息。
- 补偿：AGENTS.md 强规则 + 工具描述中强化（如 `load_constraints` 描述写"修改 ADR 覆盖的代码前必须调用"）。长对话遗忘风险由模型自觉承担，无法根治。若未来 Codex hooks ⚠️ 演进为可注入上下文的中间件，可回补。

### 6-3. write/edit 触碰 ADR 覆盖文件时告警

- MCP server **看不到** Codex 内置 write/edit 工具的调用结果（无 tools/result 中间件）。
- 变通 A（低成本）：放弃被动告警，AGENTS.md 规则 + `check_adr_consistency` 工具兜底。
- 变通 B（巧妙）：MCP server 对自身做 **git post-commit / fs.watch 级别的旁路检测**——对索引根目录做轻量 watch，发现 ADR 覆盖文件变更时在**下一次 `search_code`/`load_constraints` 的返回文本头部**附带告警。把"主动推送"变成"搭车返回"，与 Codex 模型兼容，成本约一天。

> 另注意：MCP server 子进程运行在 Codex 的 OS 沙箱之外，`create_adr`/`update_adr` 直接写工作区文件不受 Codex 沙箱约束——是能力也是安全面，需在 README 声明。

---

## 7. 技术风险清单

| 风险 | 等级 | 说明与对策 |
|---|---|---|
| tree-sitter 原生模块 | 中 | `tree-sitter` 0.25 + 9 个语言包走 node-gyp-build prebuild，主流平台 Node 18/20/22 无障碍；但 npx 分发首次安装可能触发本地编译。文档需写明；也可裁剪为"未预编译语言自动降级 regex chunker"（PHP 路径已有） |
| gRPC SDK 体积/启动 | 低 | `@zilliz/milvus2-sdk-node` 较重；MCP 只需 `startup_timeout_sec` 放宽 + 服务懒初始化（现有 `ensureCollection` 失败不阻塞注册的容错模式直接适用） |
| 全量索引长任务 | 中 | MCP tool call 阻塞等待数分钟在大仓可能触发客户端超时观感。对策：文档引导"首建在终端跑 CLI，Codex 内只做增量"；或 server 提供后台化 + `index_status` 轮询 |
| 17 个工具的 schema 占上下文 | 中 | Codex 会把 MCP 工具 schema 注入系统上下文。对策：启动时 env 开关（`ADR_TOOLS=0` 裁掉 8 个 ADR 工具）；描述文本沿用现有精简中文 |
| 密钥明文 | 低 | config.toml 里 `EMBEDDING_API_KEY` 为明文，替代 `role('secret')`；文档建议用 shell env 引用 |
| Codex 版本漂移 | 中 | MCP 客户端支持自 0.3x 起是稳定面，风险小；hooks/prompts/skills ⚠️ 属演进面，实施 P3 前对锁定版本复核一次 |
| Milvus 服务端依赖 | 无新增 | 与 DSH 版完全相同的部署前提（Milvus + Embedding API 可达），非移植引入 |

---

## 8. 收益评估

1. **一份核心，多端复用**：MCP 是公共协议，完成移植后 Claude Code / Cursor / Windsurf / Cline 零成本接入；
2. **架构倒逼解耦**：core / adapter 分层后，DSH 适配器与 MCP 适配器可共存于同仓（本分析不要求放弃 DSH 形态）；
3. **测试资产可保留**：现有测试 mock 的是模块（Milvus SDK、fetch），不 mock Cordis，core 层测试基本平移可用；
4. **失去的只有两样**：Web GUI 设置面板（可用 config.toml 文档替代）与 ADR 约束的运行时主动注入（只能降级为 AGENTS.md 静态规则 + 工具兜底）。

## 9. 建议

- **立项可行**，按 §5 三阶段推进；P1 用 1～2 天先打通 `search_code` 端到端，验证 Codex 侧体感后再决定 P2/P3 投入。
- 项目结构建议 `packages/core` + `packages/adapter-dsh` + `packages/adapter-mcp` 三件套起步。
- 实施前唯一的强制前置动作：在目标 Codex 版本上人工验证 ⚠️ 项（`codex mcp` 子命令、hooks/prompts 支持面），因为本环境无法联网复核文档。
