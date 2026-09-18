# dsh-context-milvus

[![npm version](https://img.shields.io/npm/v/dsh-context-milvus)](https://www.npmjs.com/package/dsh-context-milvus)
[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/bobjia/dsh-context-milvus)

[English](README.md) | **简体中文**

DSH 插件：通过 **Milvus** 向量数据库实现语义代码搜索，支持完整的索引 ↔ 搜索闭环。

> dsh-context-milvus = **给 DSH Agent 装上一套代码库专用语义检索引擎，Milvus 负责高速向量语义检索，把"大海捞针式 grep"变成"精准召回相关代码片段"，降 token、减工具调用、提升大仓库下编码 Agent 质量**。

---

## Why dsh-context-milvus?

`dsh-context-milvus` 是面向 **DeepSeek Harness（DSH）编码 Agent** 的开源代码语义检索插件，底层使用 Milvus 做向量库，以 DSH 插件（Cordis Plugin）形式提供工具注册。核心目的：**解决原生 DSH Agent 仅靠 grep 字符串搜索带来的高 token 消耗、多轮工具调用、上下文污染、大型代码库理解差的问题**。

> 原生 DSH Agent 工作方式：遇到问题反复 `search_code`（grep）→ `read` 文件 → 再 search，大量无关文本灌入 prompt，工具调用爆炸，token 成本高，大仓库容易"找错代码、漏看依赖"。

### 解决原生 grep 检索的几大硬伤

| 原生 grep 模式痛点 | dsh-context-milvus 的解决方式 |
|---|---|
| 只能字面字符串匹配，语义相关但命名不同的代码找不到 | **向量语义检索**，按代码含义匹配，不是只匹配关键词 |
| 多轮工具调用，反复读一堆无关文件，token 暴涨 | 只召回真正相关的代码片段，通过 AST 按函数/类边界切分，精准命中 |
| 把大量 grep 输出、无关源码塞进上下文，造成**上下文失焦污染**，模型推理质量下降 | Milvus 预建索引，Agent 一次工具调用拿到精简有效上下文，不把检索中间噪音塞进 prompt |
| 大仓库上千文件，Agent 遍历效率极低 | Milvus 向量库做百万级代码块快速检索，支持增量更新代码索引，不用每次扫描整个仓库 |
| 只能搜索已打开的或已知路径的文件 | 全仓库索引后，可按语义搜索任何位置的相关代码，不依赖文件路径记忆 |

---

## 功能

- **`search_code`** — 语义搜索代码：输入自然语言查询，返回匹配的代码片段
- **`index_code`** — 索引代码仓库：AST 解析 + 分块 → Embedding → 存储到 Milvus
- **`index_status`** — 查看索引状态：文件数量、最后索引时间、哈希统计
- **`find_callers`** — 代码关系分析（影响分析）：查找引用某个符号的所有位置，支持跨文件 import 精确解析
- **`trace_call_chain`** — 调用链追踪：从入口符号 BFS 展开调用链（影响/依赖分析），支持跨文件解析消歧
- **混合检索** — BM25 关键词 + 向量语义双路检索，RRF 融合，`hybridMode` 控制开关
- **分块重叠** — AST 分块附带上下文行（`chunkContextLines`，默认 2），提升检索召回率
- **查询扩展** — 用代码同义词扩充查询后再 embedding（`queryExpansion`，默认开启）
- **两阶段重排序** — 先取 topK×3 候选池，再按比例化术语重叠和名称匹配提升排序，Milvus 分数仍是主要信号（`rerankEnabled`，默认开启）
- **忽略模式系统** — 三层 gitignore 风格忽略规则（默认模式 + 代码库忽略文件 + 全局忽略文件）
- **增量索引** — 基于 Merkle SHA-256 哈希追踪，仅处理变更文件
- **工作区隔离** — 不同工作区使用独立的 Merkle 状态文件，互不干扰
- **ADR 决策记忆系统** — 记录代码变更背后的设计原因（Architecture Decision Record），支持语义搜索、CRUD、约束注入和一致性检查
- **代码关系分析** — 索引时从 AST 提取每个代码块引用的符号（`references`，各语言树状语法节点），支持跨文件精确匹配
- **跨文件 import 解析（V2）** — 索引期用 tree-sitter AST 扫描 import/export 语句，构建持久化双向 Import Map，`find_callers` / `trace_call_chain` 据此做跨文件符号精确匹配（同名消歧、跨模块追踪）
- **原生遥测（opt-in）** — `search_code` / `index_code` / `index_status` 每次执行写一行 JSONL（默认关闭，不采源代码内容），附带分析脚本做描述统计 + Bootstrap CI + 相关性

---

## Codex CLI 支持

本插件的检索引擎已抽成独立包 `dsh-context-milvus-core`，同一份代码也可以 stdio **MCP server** 形态运行：`codex-context-milvus` 面向 [OpenAI Codex CLI](https://github.com/openai/codex)（以及任何 MCP 客户端），暴露 5 个检索工具 —— `search_code`、`index_code`、`index_status`、`find_callers`、`trace_call_chain`，并与 DSH 插件共用同一份 Milvus 集合和按工作区隔离的索引状态。以 `ADR_ENABLED=true` 启动时，另外注册 8 个 ADR 决策记忆工具；其中 4 个写盘工具仍受 `CONTEXT_MILVUS_ADR_WRITE` 保护，默认拒绝。

最短接入：

```bash
codex mcp add context-milvus -- npx -y codex-context-milvus mcp
```

或在目标仓库里用向导写项目级配置：

```bash
npx -y codex-context-milvus init --yes    # 生成 / 更新 .codex/config.toml，默认不写密钥
npx -y codex-context-milvus doctor        # 探测 Embedding 与 Milvus 连通性
```

环境变量参考、错误码表与当前限制（ADR 工具默认关闭、无运行时热更新、未接入 MCP Roots）见 [`packages/codex/README.md`](packages/codex/README.md)。

### 离线安装（隔离网络环境）

离线机器无法解析约 230 个包的生产依赖闭包，所以离线包必须在一台能连 registry 的机器上制作：用一个只声明本包的临时工程把闭包拉全，再选择带走 npm 缓存或整个 `node_modules`。

```bash
mkdir ctxmilvus-offline && cd ctxmilvus-offline
npm init -y
npm pkg set dependencies.codex-context-milvus=0.7.1
npm install --omit=dev --cache ./npm-cache

tar czf ctxmilvus-offline.tgz npm-cache package.json package-lock.json   # 方案 A
tar czf ctxmilvus-tree.tgz node_modules                                  # 方案 B
```

到目标机上，方案 A 用 `npm ci --omit=dev --offline --cache ./npm-cache` 安装（`--offline` 保证缺包时直接 `ENOTCACHED` 报错，而不是卡在不存在的网络上；若目标机完全不能跑 npm，用方案 B：解压后直接调用 `node_modules/.bin/codex-context-milvus`）。两个坑：一是向导生成的 `config.toml` 用 `npx -y` 启动服务，那等于每次 Codex 启动都要连 registry，必须把 `command` / `args` 改成本地 `bin/mcp.js` 的绝对路径；二是 `tree-sitter*` 的原生预编译产物本身就打在 npm 包里（linux / darwin / win32 × x64 / arm64 全覆盖，且 `node-gyp-build` 不会联网下载），所以一份离线包跨平台通用，但这六种之外的平台需要在安装期编译（`python3` + `make` + `g++`）。完整步骤（含按目标平台裁剪预编译产物、以及改好的 TOML）见 [`packages/codex/README.md` 的 Offline install 一节](packages/codex/README.md#offline-install-air-gapped-target)。

---

## 效果评测

一套可复现的统计评测体系（见 `scripts/eval/`）用量化数据证明 `dsh-context-milvus` 的检索质量和端到端 Agent 效率提升。覆盖离线检索质量、端到端 Agent 评测和原生遥测三个层面，使用非参数统计（Wilcoxon、Bootstrap CI、Cliff's Δ），以文件级相关性为统一口径。评测报告见 `scripts/eval/*/output/report.md`。

### 离线检索质量 — 21 条标注查询 × 19 文件多语言语料库

三组对比：**G**（grep 关键词）、**R**（朴素 RAG：固定滑窗 + 纯向量）、**P**（插件：AST 分块 + BM25 混合 + RRF 融合 + 分块重叠 + 查询扩展 + 两阶段重排序）。

| 指标 | G (grep) | R (朴素 RAG) | P (插件) |
|------|:--------:|:------------:|:--------:|
| recall@10 | 0.9524 | **1.0000** | 0.9524 |
| MRR | **0.6754** | **0.9524** | 0.8452 |
| nDCG@10 | 0.7446 | **0.9610** | 0.8725 |
| **hit@1** | 0.4762 | 0.9048 | **0.7619** |
| precision@10（文件级） | **0.4203** | 0.1095 | 0.2730 |
| precision@10-chunk（条目级） | — | — | **0.3619** |

> **关于 precision@10 的说明**：报告两种口径。**文件级** precision@10 对结果按文件路径去重（每个文件只计一次），衡量 top-K 中出现了多少不同的相关文件。**条目级** precision@10 对每个返回结果独立判定，对应经典 IR 定义："Agent 看到的 10 条结果中，有多少条来自相关文件？"条目级指标更高，因为 Agent 能受益于同一相关文件的多个 chunk 聚集在 top 结果中。

关键发现：

- **两阶段重排序提升 hit@1 达 6.7%**（相对 P0 基线从 0.714 提升至 0.762）：比例化术语重叠（+30%）和名称匹配（+15%）改善首项命中率，无激进多样性惩罚。
- **条目级 precision@10 = 0.362**：Agent 每 10 条结果中约 3.6 条来自相关文件。这个值受限于语料库设计（每个查询只有 1-2 个相关文件，每个文件产生少量 chunk）——天花板由相关文件 chunk 数决定，而非检索质量。
- **AST 分块 + 分块重叠 + 查询扩展共同提升精度**：P vs R precision@10 +0.1635（p=0.00013，Cliff's Δ=0.868 大效应）。函数/类边界分块配合上下文行，比固定滑窗更聚焦。
- **语义检索排名效果优于 grep**：P vs G MRR +0.1698（p=0.108），nDCG@10 +0.1280（p=0.100）——相关文件排名更高，p 值接近显著。
- **grep 精度高但召回脆弱**：G 拥有最高的 precision@10（0.4203），但 hit@1 最低（0.4762）——纯关键词检索会漏掉语义相关但用词不同的代码（如"指数退避重试"永远匹配不到 `withRetry`）。

### 端到端 Agent 评测 — 8 个任务 × 3 次运行 × 3 组策略

| 组 | 平均通过率 | Token 消耗 |
|----|:---------:|:----------:|
| G (grep) | 37.5% | 基准 |
| R (朴素 RAG) | 50.0% | 比 G 少 928 |
| **P (插件)** | **62.5%** | **比 G 少 2109** |

关键发现：

- **最高任务通过率**：P 62.5% > R 50.0% > G 37.5%。
- **显著降低 token 消耗**：P vs G 每任务 Δ均值 −2109 (95% CI [−2325, −1864])，Wilcoxon p=0.014，**Holm 校正后显著**，Cliff's Δ=−1.0。P vs R 也少 928 tokens/任务（p=0.014）。

### 原生遥测（opt-in）

`search_code` / `index_code` / `index_status` 每次执行记录一条 JSONL（含查询文本、结果数、最高分、耗时、索引文件/分块数等），**默认关闭**（`telemetryEnabled: false`），不采集源代码内容。运行 `node scripts/eval/telemetry/run.mjs` 从 `~/.milvus-index/telemetry.jsonl` 生成描述统计 + Bootstrap CI + 相关性报告。

---

## Milvus 在这里承担什么角色，为什么选 Milvus

1. **存储 AST 分块后的代码向量**：dsh-context-milvus 会用 tree-sitter AST 语法树把代码按函数/类/方法边界切分代码块，生成 embedding 存入 Milvus，避免把一个函数拦腰切断。
2. **高性能向量检索**：对 query 编码后做向量相似度检索，低延迟，适合 Agent 实时工具调用场景。
   > 注：BM25 关键词融合**已实现**——Milvus 原生 BM25 全文检索与向量语义双路检索，RRF 融合（`hybridMode` 默认开启）。
3. **支持自托管 Milvus 实例 / Zilliz Cloud 托管版**，两种部署形态可选，团队可以管控数据；支持增量索引，代码变更后增量更新，不用全量重建索引。
4. **专门适配代码 RAG**：支持按路径范围过滤（`search_code` 的 `path` 参数），检索时可以限定目录，非常适合代码库场景。

---

## DSH 插件架构带来的优势

它不是独立的 MCP 服务，而是作为 **DSH 插件**（Cordis Plugin）直接嵌入 DSH Agent 进程：

- **零额外网络开销**：插件与 Agent 同进程，工具调用不走 HTTP，延迟远低于 MCP
- **天然共享 DSH 资源配置**：复用 DSH 的配置管理、环境变量注入、日志系统，无需额外配置
- **DSH Web GUI 集成**：通过 Settings → Plugins 界面可视化配置，无需手写 YAML
- **DSH 生态兼容**：与其他 DSH 插件（bash、agent-loop、web-search 等）共享工具注册表，Agent 可自由组合调用

---

## 核心工作流程

### 注册的三个 DSH 工具

| 工具名 | 功能 | 关键参数 |
|--------|------|----------|
| `search_code` | 语义搜索代码 | `query`（自然语言查询）、`topK`（结果数）、`path`（搜索范围限定） |
| `index_code` | 索引代码仓库 | `mode`（full 全量 / incremental 增量）、`path`（指定路径） |
| `index_status` | 查看索引状态 | `path`（指定路径查看独立状态） |
| `search_adr` | 语义搜索 ADR 决策记录 | `query`（自然语言查询）、`status`、`topK` |
| `search_adr_by_file` | 通过代码文件路径查找关联的 ADR | `file_path`（代码文件路径）、`status` |
| `create_adr` | 创建新的 ADR 决策记录 | `title`（必填）、`requirement`、`change_type` |
| `update_adr` | 更新已有 ADR 决策记录 | `adr_id`（必填）、`content`、`status` |
| `list_adrs` | 列出 ADR 决策记录目录 | `status`、`change_type`、`limit` |
| `load_constraints` | 加载 active ADR 的约束条件 | `adr_ids`、`format` |
| `check_adr_consistency` | 检查 ADR 与代码的一致性 | `file_path`、`fix` |
| `find_callers` | 查找引用某符号的所有位置，用于修改影响分析，支持跨文件 import 精确解析 | `symbol`（必填）、`direction`、`maxResults`、`sourceFile`、`resolve` |
| `trace_call_chain` | 从入口符号 BFS 追踪调用链（影响/依赖分析），支持 import 解析消歧 | `entry`（必填）、`direction`、`maxDepth`、`maxResults`、`resolve` |

### 工作流程

1. 执行 `index_code` 工具：解析项目，tree-sitter AST 拆分代码块 → 调用 Embedding 模型生成向量 → 存入 Milvus 集合。
2. Agent 遇到编码问题，调用 `search_code` 工具向 Milvus 发起**混合检索**（向量语义 + BM25 关键词，RRF 融合）。
3. Milvus 返回最相关的少量代码片段，注入 Agent 上下文。
4. Agent 基于精准上下文做调试、重构、开发，不再疯狂 grep 读一堆文件。
5. 代码变更后，执行 `index_code mode=incremental` 增量更新，只重新索引变更的文件。
6. 随时通过 `index_status` 查看索引状态（已索引文件数、代码块总数、最后索引时间）。
7. 修改代码前用 `find_callers` 做影响分析：查看哪些地方引用了要修改的符号，避免遗漏连锁影响。同名符号跨文件时，用 `sourceFile` 参数限定定义文件做精确消歧。
8. 理解功能调用链用 `trace_call_chain`：从入口函数 BFS 展开调用链，`direction=backward` 追踪调用者，`direction=forward` 追踪下游依赖。`resolve: false` 可回退到 V1 名称匹配模式。
9. 跨文件引用分析：`find_callers` 和 `trace_call_chain` 默认启用 import 解析（`resolve: true`），索引期构建的 Import Map 自动将 `import { X } from './foo'` 映射到 `foo.ts` 的导出，消除同名符号歧义，支持跨模块调用链追踪。当 import map 未构建时自动降级为 V1 名称匹配。

### ADR 决策记忆工作流程

ADR 决策记忆系统记录代码变更背后的"为什么"（设计决策、权衡、约束），让 Agent 不仅能读代码，还能理解其演进原因：

> **注意：** ADR 功能默认关闭。如需启用，在 DSH 配置面板（Settings → Plugins → dsh-context-milvus）中设置 `adrEnabled: true`。

1. **修改有 ADR 覆盖的代码前**，建议用 `search_adr_by_file` 查询该文件是否有 ADR 决策记录覆盖，避免违反既有决策。
2. **做出设计决策时**，用 `create_adr` 记录决策背景、备选方案与理由，并通过 `update_adr` 维护 code_anchors 关联的代码位置。
3. **需要了解约束时**，用 `load_constraints` 加载 active ADR 的约束条件注入上下文。
4. **创建或更新 ADR 后**，建议用 `check_adr_consistency` 校验 ADR 与代码实现的一致性，必要时 `fix` 自动修复。
5. 用 `search_adr` 语义搜索历史决策，理解代码"为什么这么做"。

---

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

---

## 前置条件

### 1. 安装 Ollama（Embedding 服务）

```bash
# macOS
brew install ollama

# Linux
curl -fsSL https://ollama.com/install.sh | sh

# 启动 Ollama 服务
ollama serve
```

> 或使用任意 OpenAI 兼容的 Embedding API 服务（如 OpenAI、阿里云百炼等），通过配置 `embeddingEndpoint` 和 `embeddingApiKey` 切换。

### 2. 安装 Embedding 模型

```bash
# 拉取 nomic-embed-text 模型（默认配置）
ollama pull nomic-embed-text

# 或其他支持的 Embedding 模型，如：
ollama pull bge-m3
ollama pull mxbai-embed-large
```

### 3. 安装 Milvus（向量数据库）

**Docker 方式（推荐）：**

```bash
# 拉取并启动 Milvus 单机版
docker run -d --name milvus \
  -p 19530:19530 \
  -p 9091:9091 \
  milvusdb/milvus:latest

# 验证连接
docker ps | grep milvus
```

**Milvus 集群模式（Docker Compose）：**

```bash
# 下载 docker-compose 文件
wget https://github.com/milvus-io/milvus/releases/latest/download/milvus-standalone-docker-compose.yml -O docker-compose.yml

# 启动
docker compose up -d
```

> 或使用 [Zilliz Cloud](https://cloud.zilliz.com) 托管版，无需自运维。

### 验证安装

```bash
# 验证 Ollama
curl http://localhost:11434/api/tags

# 验证 Milvus
docker run -it --rm \
  -e MILVUS_URL=localhost:19530 \
  milvusdb/milvus-sdk-node:latest \
  node -e "const {MilvusClient} = require('@zilliz/milvus2-sdk-node'); \
  new MilvusClient({address:'localhost:19530'}).listCollections().then(r=>console.log(r))"
```

---

## 安装到 DSH

### 方式一：从 npm 安装（推荐）

插件已发布到 npm registry，直接通过 DSH CLI 安装：

```bash
dsh plugin --profile web add dsh-context-milvus
```

> npm 包内置编译后的 `dist/` 产物，安装时无需执行构建脚本，不会遇到 pnpm 的 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED` 拦截。

### 方式二：从本地 tarball 安装（离线 / 本地开发场景）

构建并打包成 tarball，然后直接安装：

```bash
# 1. 构建
npm run build

# 2. 打包成 tarball
pnpm pack

# 3. 安装到 profile
dsh plugin --profile web add ./dsh-context-milvus-0.1.3.tgz
```

> `pnpm pack` 打包的 tarball 包含编译后的 `dist/` 产物，安装时无需执行构建脚本，所以 pnpm 不会报 `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`。

### 方式三：从 Git 安装（需额外配置）

```bash
dsh plugin --profile web add git+https://github.com/bobjia/dsh-context-milvus.git
```

> `dist/` 产物不提交到 git，插件通过 `prepare` 脚本在安装时自动运行 `tsc` 生成构建产物。
>
> **pnpm 10 限制**：pnpm 10 默认会阻止依赖执行构建脚本。若安装报以下错误：
> ```
> ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED
> The git-hosted package "dsh-context-milvus@0.1.2" needs to execute build scripts
> but is not in the "onlyBuiltDependencies" allowlist.
> ```
> 需要在 profile 的 `pnpm-workspace.yaml` 中添加：
> ```yaml
> # ~/.dsh/profiles/<profile-name>/pnpm-workspace.yaml
> onlyBuiltDependencies:
> - dsh-context-milvus
> ```
> 然后重新运行安装命令。或者运行 `pnpm approve-builds` 并勾选 `dsh-context-milvus`。
>
> 不想让用户做这项授权，就使用方式一（npm）或方式二（tarball）。

### 配置插件

安装后，编辑 profile 下的 `cordis.patch.yml` 配置插件参数：

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

配置完成后重启 DSH 即可使用。

### 从源码构建（本地开发）

如果使用本地开发版本，按以下步骤操作：

#### 1. 安装依赖

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm install --legacy-peer-deps
```

#### 2. 创建 @deepseek-ai 包的符号链接

```bash
# 链接 DSH 运行时的包（npm install 可能破坏这些链接）
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis \
  node_modules/@deepseek-ai/cordis
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools \
  node_modules/@deepseek-ai/dsh-tools
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery \
  node_modules/@deepseek-ai/schemastery
```

#### 3. 注册到 DSH

```bash
# 安装为本地依赖
dsh plugin --profile web add file:/mnt/home/bobjia/workspace/dsh-context-milvus
```

> `dsh plugin add` 会自动将插件添加到 `dsh.profile.bundles`，无需手动编辑 `package.json`。

#### 4. 配置插件

编辑 `~/.dsh/profiles/<profile-name>/cordis.patch.yml`（同上）后重启 DSH。

---

## 配置系统

### 配置优先级（高 → 低）

1. **Cordis Config**（通过 `cordis.patch.yml` 或 DSH Web GUI 设置）
2. **环境变量**（fallback）
3. **默认值**（如 `localhost:19530`）

### 配置字段一览

| 字段 | 环境变量 | 类型 | 默认值 | 说明 |
|------|---------|------|--------|------|
| `milvusAddress` | `MILVUS_ADDRESS` | string | `localhost:19530` | Milvus 服务地址 |
| `milvusToken` | `MILVUS_TOKEN` | string (secret) | 空 | Milvus 鉴权 Token |
| `milvusCollection` | `MILVUS_COLLECTION` | string | `code_embeddings` | 集合名称 |
| `milvusDim` | `MILVUS_EMBEDDING_DIM` | number | `768` | 向量维度 |
| `embeddingEndpoint` | `EMBEDDING_ENDPOINT` | string | `http://localhost:11434/api/embed` | Embedding API 地址 |
| `embeddingApiKey` | `EMBEDDING_API_KEY` | string (secret) | 空 | Embedding API 密钥 |
| `embeddingModel` | `EMBEDDING_MODEL` | string | `nomic-embed-text` | Embedding 模型名称 |
| `indexRoot` | `INDEX_ROOT` | string | `process.cwd()` | 代码仓库根路径 |
| `indexExtensions` | `INDEX_EXTENSIONS` | string | 所有支持的扩展名 | 索引的文件后缀（逗号分隔） |
| `hybridMode` | `HYBRID_MODE` | boolean | `true` | 启用混合检索（BM25 全文 + 向量语义，RRF 融合） |
| `bm25RrfK` | `BM25_RRF_K` | number | `60` | RRF 融合参数 k |
| `indexIgnoreDirs` | `INDEX_IGNORE_DIRS` | string | dist, build, target, vendor, ... | 扫描时跳过的目录名 |
| `ignorePatterns` | `IGNORE_PATTERNS` | string (textarea) | 空 | 自定义 gitignore 风格忽略规则 |
| `merkleFilePath` | `MERKLE_FILE_PATH` | string | `~/.milvus-index/merkle-{name}-{hash}.json` | Merkle 状态文件路径 |

---

## 工具说明

### `search_code`

语义搜索代码。当用户提出模糊的功能需求、询问代码逻辑或需要根据自然语言描述查找代码时自动调用。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 用户的自然语言查询 |
| `topK` | number | 否 | 5 | 返回最相关的结果数量 |
| `path` | string | 否 | (配置的根路径) | 搜索范围限定路径 |

**返回格式：**

```json
[
  {
    "filePath": "src/auth/login.ts",
    "content": "export async function loginUser(credentials) { ... }",
    "score": 0.0164,
    "scoreKind": "rrf",
    "language": "typescript",
    "chunkType": "function_declaration",
    "name": "loginUser",
    "startLine": 42,
    "endLine": 68
  }
]
```

> **`score` 的含义取决于 `hybridMode`** —— 由 `scoreKind` 标明。混合检索开启时（默认）Milvus 返回的是 **RRF 融合分**，约为 `1/(bm25RrfK + 名次)`：它表达的是**名次**而非相似度，量级在 0.016 附近，**不可**当作匹配百分比，也不可与余弦值比较。`hybridMode: false` 时才是真正的余弦相似度（通常 0.5~0.8）。渲染文本与此一致：RRF 结果输出 `排序: N/M` 而非相关度数值，避免把名次误读成匹配质量。

### `index_code`

索引代码仓库。支持两种模式：

- **`full`** — 全量索引所有文件
- **`incremental`** — 增量索引（仅处理变更文件，基于 Merkle 哈希）

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `mode` | string | 否 | `incremental` | 索引模式：`full` 或 `incremental` |
| `path` | string | 否 | (配置的根路径) | 要索引的路径 |

**大工作区降级：** 当**本次运行**需要索引的文件数 > 1000，或这些文件的源码文本总量 > 500 KiB（UTF-8 字节）时，
`index_code` 只做扫描统计并立即返回，**不做分块、不调用 Embedding、不写 Milvus**，
同时给出可在终端直接运行的索引命令（见下文「独立索引脚本」），并带上你请求的 `--mode`。
这是为了避免大仓库把一次工具调用拖到超时，并在用户不知情的情况下产生 embedding 费用。

阈值按**本次工作量**而非整个工作区规模计算，所以大仓库上只改少量文件的增量更新会**正常内联执行**；
`mode=full` 与首次索引会重索引全部文件，因此工作区一旦超限即降级。Codex 的 `index_code` 不参与降级。

### `index_status`

查看索引状态，包括文件数量、代码块总数、最后索引时间等。

**大规格库降级：** 当**本次真正需要处理**的文档 —— `specRoot` + `planRoot` 下**缺 frontmatter** 的候选文档 —— 超过 100 篇，
或这些文档的文本总量 > 200 KiB 时，`index_specs` 只做扫描统计并立即返回，**不生成 frontmatter、不写任何文件、不索引**，
并给出带 `--specs-only` 的终端命令。阈值按**候选**而非全量语料计算：后续的增量索引只在候选非空时才会执行，
因此一个文档都已有 frontmatter、无事可做的仓库不会被降级。

`index_specs(dry_run=true)` 不受此限制（预览无副作用），可用它先查看将要生成哪些锚点。

### `find_callers`

查找代码中引用某个符号（函数/变量/类）的所有位置，用于修改影响分析。V2 新增跨文件 import 精确解析：同名符号跨文件时，用 `sourceFile` 参数限定定义文件做消歧。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `symbol` | string | 是 | — | 要查找的符号名（函数名、变量名、类名） |
| `direction` | string | 否 | `backward` | `backward`=谁引用了我（影响面）；`forward`=我引用了谁（依赖面） |
| `maxResults` | number | 否 | 20 | 最大返回结果数 |
| `sourceFile` | string | 否 | — | 限定定义文件路径（显式消歧，只返回从该文件导入该符号的调用者） |
| `resolve` | boolean | 否 | `true` | 是否启用 import 解析（设为 `false` 回退到 V1 名称匹配模式） |

**返回格式：**

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

> `resolution` 字段：`status` 为 `resolved`（已解析到跨文件导入）、`local`（同文件内定义）、`unresolved`（未解析，V1 名称匹配回退）。仅启用 import 解析且 Import Map 已构建时存在。

### `trace_call_chain`

从入口符号出发，沿引用关系 BFS 追踪调用链。`direction=backward` 做影响分析（找谁调用了入口），`direction=forward` 做依赖分析（入口调用了谁）。使用 visited set 防止循环。V2 支持 import 解析消歧（`resolve: true` 默认启用），使用 `filePath:symbol` 复合键追踪跨文件调用链。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `entry` | string | 是 | — | 入口符号名 |
| `direction` | string | 否 | `backward` | 展开方向 |
| `maxDepth` | number | 否 | 3 | 最大递归深度 |
| `maxResults` | number | 否 | 10 | 每层最大结果数 |
| `resolve` | boolean | 否 | `true` | 是否启用 import 解析（设为 `false` 回退到 V1） |

**返回格式：**

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

## 独立索引脚本

大工作区下插件会把重活交给你在终端独立完成。脚本随 `dsh-context-milvus` 一起发布：

```bash
# 完整索引：代码 → spec/plan frontmatter 生成 → ADR/规格索引
node ~/.dsh/profiles/web/node_modules/dsh-context-milvus/bin/index.js --root /path/to/workspace

# 只处理规格文档
node ~/.dsh/profiles/web/node_modules/dsh-context-milvus/bin/index.js --root /path/to/workspace --specs-only

# 先看规模（不连 Milvus、不写任何东西）
node ~/.dsh/profiles/web/node_modules/dsh-context-milvus/bin/index.js --root /path/to/workspace --dry-run
```

| 参数 | 说明 |
|------|------|
| `--root <path>` | 工作区根目录（默认当前目录） |
| `--mode full\|incremental` | 索引模式（默认 `incremental`） |
| `--config <path>` | 指定 run-config（默认按 `--root` 派生） |
| `--specs-only` | 只做 spec/plan 的 frontmatter 生成与索引 |
| `--no-adr` | 跳过 ADR 与规格索引 |
| `--dry-run` | 只扫描统计 |
| `--verbose` | 打印逐文件进度 |
| `-h`, `--help` | 显示用法 |

退出码：`0` 成功、`1` 运行失败、`2` 用法错误；`Ctrl-C` 会先落盘进度再以 `130` 退出，重跑自动续传。

**配置来源：** 脚本优先读取 `~/.milvus-index/run-config-<工作区名>-<hash>.json` ——
这是 `index_code` / `index_specs` 降级时写下的**解析后有效配置**（含 Milvus 地址/token、
embedding 端点/模型等，文件权限 `0600`），因此脚本与插件使用完全一致的设置。
没有该文件时回退到环境变量与默认值，并打印警告。

**不要与插件同时运行索引**：两者不会损坏数据，但会重复劳动。

### 已知限制：多机器共享同一个集合

索引键 `file_path` 是**本机绝对路径**，"是否已索引"由本机的
`~/.milvus-index/merkle-*.json` 判断。因此当多个用户在不同电脑上克隆同一个
Git 工程、却指向**同一个远程 Milvus 集合**时：

- 每个克隆会各自写入一份（同一文件、不同绝对路径 → 两套行），删除互不影响；
- 各自的 Merkle 状态互相看不见，同一份代码会被重复 embedding（重复计费）；
- 检索结果里会混入其他机器的绝对路径，本机打不开。

**建议：每个工作区/每个用户使用各自的集合**（在 DSH 设置面板里改
`milvusCollection` / `adrCollection`）。共享集合目前只在"所有人把仓库克隆到
完全相同的绝对路径、且集合名 / `milvusDim` / embedding 模型完全一致"时才安全。

## 代码分块

| 语言 | 扩展名 | 分块方式 | 覆盖的 AST 节点类型 |
|------|--------|----------|--------------------|
| TypeScript | .ts, .tsx, .mts, .cts | tree-sitter | function_declaration, method_definition, class_declaration, interface_declaration, enum_declaration, type_alias_declaration, arrow_function, generator_function, getter, setter |
| JavaScript | .js, .jsx, .mjs, .cjs | tree-sitter | function_declaration, method_definition, class_declaration, arrow_function, generator_function, getter, setter |
| Python | .py | tree-sitter + regex 回退 | function_definition, class_definition, async_function_definition, decorated_definition |
| Java | .java | tree-sitter + regex 回退 | class_declaration, interface_declaration, enum_declaration, method_declaration, constructor_declaration, record_declaration |
| Go | .go | tree-sitter + regex 回退 | function_declaration, method_declaration, type_declaration, type_spec |
| Rust | .rs | tree-sitter + regex 回退 | function_item, impl_item, trait_item, struct_item, enum_item, macro_definition |
| C | .c, .inc | tree-sitter + regex 回退 | function_definition, struct_specifier, enum_specifier, union_specifier, type_definition, preproc_function_def, declaration (prototypes only) |
| C++ | .cpp, .cxx, .cc, .hpp, .h, .hh | tree-sitter + regex 回退 | function_definition, class_specifier, namespace_definition, struct_specifier, enum_specifier |
| C# | .cs | tree-sitter + regex 回退 | method_declaration, class_declaration, interface_declaration, struct_declaration, enum_declaration |
| Scala | .scala | tree-sitter + regex 回退 | class_definition, function_definition, trait_definition, object_definition, constructor_definition |
| PHP | .php | regex 回退 | function_definition, class_declaration, interface_declaration, trait_declaration, enum_declaration |

> 除 PHP（纯 regex）外均优先使用 tree-sitter AST 解析。其中 Python、Java、Go、Rust、C++、C#、Scala 在 tree-sitter 解析失败时自动降级到 regex 回退；**TypeScript / JavaScript 没有 regex 回退**——若 tree-sitter 解析失败，该文件会被跳过（不产生索引）。

---

## 忽略规则系统（IgnoreMatcher）

三层 gitignore 风格的文件忽略规则，确保索引时只索引真正需要分析的代码文件：

### 三层规则

1. **内置默认规则**：自动排除 `node_modules/`、`dist/`、`build/`、`.git/`、`__pycache__/`、`*.log`、`*.min.js` 等 30+ 条常见构建产物和依赖目录
2. **代码库忽略文件**：自动读取代码库根目录下的 `.gitignore`、`.ignore`、`.xxxignore` 等文件
3. **全局忽略文件**：读取 `~/.context/.contextignore`（用户级全局规则）

### 自动隐藏路径保护

自动忽略以 `.` 开头的路径段（如 `.git/`、`.vscode/`、`.env`），防止隐藏目录和文件被误索引。

### 向后兼容

配置中的 `indexIgnoreDirs`（逗号分隔的目录名列表）会自动转换为 gitignore 风格模式（如 `dist` → `**/dist/**`），与旧版本兼容。

---

## 增量索引与工作区隔离

### 增量索引（Merkle 哈希追踪）

- 使用 SHA-256 哈希追踪每个文件的内容变化
- 索引时只重新索引新增或修改的文件，跳过未变更的文件
- 删除的文件自动从 Milvus 中移除
- 状态持久化到本地 JSON 文件

### 工作区隔离

- 不同工作区使用独立的 Merkle 状态文件
- 状态文件路径基于工作区路径的 SHA-256 哈希生成
- 索引不同工作区不会互相干扰
- 工具调用时通过 `path` 参数指定工作区，自动使用对应的状态文件

---

## 什么时候应该用，什么时候不建议

### ✅ 适合场景

- 几十~百万行规模代码仓库，使用 DSH Agent 做重构、bug 定位、跨文件阅读；
- 希望降低 token 开销，减少 Agent 来回 grep 的工具循环；
- 需要开源可自托管，不想依赖闭源索引服务；
- 已在使用 DSH 框架，希望为 Agent 增强代码理解能力；
- 需要增量索引，代码频繁变更但不想每次全量重建。

### ❌ 不适合 / 注意点

1. 需要 embedding API（OpenAI / Ollama 等），索引阶段代码片段会送给 embedding 服务；隐私要求极高可搭配 Ollama 本地 Embedding；
2. 多了 Milvus / Zilliz Cloud 依赖，增加运维复杂度；小仓库（几百文件以内）收益不明显；
3. 它是检索增强，**不能替代模型本身的上下文窗口**，只是筛选高质量上下文，解决"噪音过载"而不是无限放大窗口；
4. 需要 DSH 环境（v0.6+），不能独立于 DSH 运行。

---

## 对比：自建代码 RAG vs dsh-context-milvus

如果你自己写一套代码 RAG for DSH Agent：要处理 AST 分块、向量检索调参、增量同步代码变更、DSH 工具封装、结果排序、忽略文件系统；dsh-context-milvus 已经把这套工程全部封装好，开箱即用，专门针对代码场景调优过。

| 对比维度 | 自建代码 RAG | dsh-context-milvus |
|----------|-------------|-------------------|
| AST 分块 | 自行集成 tree-sitter，每种语言单独配置 | 内置 10 种语言 tree-sitter 分块，自动回退到 regex |
| 语义检索 | 自行调用 embedding 服务并调参 | 内置向量语义检索，开箱即用（BM25 关键词融合） |
| 增量索引 | 自行实现文件哈希对比和状态管理 | 内置 Merkle 文件状态追踪，SHA-256 哈希，增量更新 |
| 工作区隔离 | 自行处理多工作区状态冲突 | 自动基于路径哈希隔离，互不干扰 |
| 忽略文件 | 自行实现 .gitignore 解析 | 内置三层忽略规则系统（默认 + 代码库 + 全局） |
| DSH 工具封装 | 自行封装 DSH 工具（defineTool） | 13 个原生 DSH 工具（5 代码工具 + 8 ADR 工具），一键注册，含输出格式化 |
| 配置界面 | 自行实现或手写 YAML | DSH Web GUI 可视化配置，13 个配置字段 |
| 配置来源 | 单一来源 | 三源合并（Cordis Config > 环境变量 > 默认值） |
| 索引状态 | 自行实现查看 | 内置 `index_status` 工具，实时查看索引状态 |

---

## DSH Web 界面配置

安装后，在 DSH Web 界面 (http://127.0.0.1:3080) 的 **Settings → Plugins** 中可以看到 `dsh-context-milvus` 及其配置表单，支持：

- 文本输入框（普通字段）
- 密码输入框（secret 字段，如 `milvusToken`、`embeddingApiKey`）
- 数值输入框（number 字段，如 `milvusDim`）
- 开关（boolean 字段，如 `hybridMode`）
- 字段说明/提示文本

---

## 架构

```
┌──────────────────────────────────────────┐  ┌──────────────────────────────────────┐
│      DSH Agent / Web UI（13 个工具）      │  │   OpenAI Codex CLI / 任意 MCP 客户端  │
│  search_code │ index_code │ index_status │  │      5 个工具（MCP stdio）            │
│  find_callers │ trace_call_chain         │  │  search_code │ index_code │ ...      │
│  8 个 ADR 工具（决策记忆）                │  │   ADR 工具需 ADR_ENABLED               │
└────────────────────┬─────────────────────┘  └───────────────────┬──────────────────┘
                     │                                            │
        packages/dsh（Cordis 适配器）              packages/codex（MCP 适配器 + CLI）
        tools.ts / adr-tools.ts /                  server.ts / handlers.ts /
        constraint-injector.ts                     init-wizard.ts / doctor.ts
                     │                                            │
                     └────────────────────┬───────────────────────┘
                                          ▼
                packages/core — dsh-context-milvus-core（框架无关引擎）
   ┌──────────────────────────────────────────────────────────────────────────────┐
   │  chunker(AST+regex) → embedding → milvus-service        merkle（SHA-256 Δ）  │
   │  code-relations（BFS findCallers/traceChain）           import-resolver      │
   │  query-expansion → reranker                            ignore-matcher（三层） │
   │  telemetry（JSONL，opt-in）                             logger 端口           │
   │  ADR 引擎：frontmatter/chunker/anchors/service/indexer/bundle                 │
   └──────────────────────────────────────────────────────────────────────────────┘
                                          │
                          ┌───────────────┴───────────────┐
                     ┌──────────┐                   ┌──────────┐
                     │  Milvus  │                   │Embedding │
                     │ (向量库) │                   │   API    │
                     └──────────┘                   └──────────┘
```

两个适配器都只依赖 core 包，彼此不互相依赖。core 的边界由测试强制：不得 import `@deepseek-ai/*`、`@modelcontextprotocol/*`、`zod`，也不得直接调用 `console.*`（日志走注入的 `Logger`）。

### 模块依赖关系

core（`packages/core/src/`，适配器只通过 `index.ts` barrel 使用）：

```
index.ts (barrel)
  ├── config.ts     — 配置解析（适配器配置 > 环境变量 > 默认值）
  │     └── DEFAULT_IGNORE_PATTERNS — 内置 gitignore 风格忽略规则
  ├── milvus-service.ts — Milvus 向量数据库客户端封装（CRUD、搜索、ADR 集合）
  │     ├── embedding.ts — OpenAI 兼容 Embedding API 客户端
  │     ├── query-expansion.ts / reranker.ts — 检索质量阶段
  │     └── logger.ts — Logger 端口（consoleLogger / silentLogger）
  ├── merkle.ts     — SHA-256 哈希追踪器（增量索引，持久化到 JSON）
  ├── code-relations.ts — 代码关系分析引擎（BFS 调用链 + 去噪）
  │     └── import-resolver.ts — 跨文件 Import Map（tree-sitter AST 扫描 import/export）
  ├── ignore-matcher.ts — gitignore 风格模式匹配（文件排除）
  └── indexer.ts    — 索引管线编排
        └── chunker.ts — tree-sitter AST 分块 + regex 回退 (含 references 提取 + 语言 import/export 配置)
```

DSH 适配器（`packages/dsh/src/plugins/dsh-context-milvus/`）：

```
index.ts        — Cordis 入口：服务装配、设置面板、注册 13 个工具
tools.ts        — DSH 工具定义、格式化、工作区感知的追踪器创建
adr-frontmatter.ts — YAML frontmatter 解析
adr-chunker.ts     — Markdown 章节分块
adr-anchor-index.ts / adr-anchor-generator.ts — code_anchors 索引与锚点生成
adr-service.ts     — ADR CRUD + 状态管理
adr-indexer.ts     — ADR 索引管道
adr-tools.ts       — 8 个 ADR 工具
constraint-injector.ts — 系统提示注入 + 约束重注入
```

Codex 适配器（`packages/codex/src/`）：`workspace-resolver.ts` → `context.ts`（stderr 日志）→ `workspace-services.ts`（按工作区缓存服务）→ `handlers.ts`（5 个工具）→ `server.ts`（MCP 装配），外加 `result-format.ts` / `schemas.ts`，CLI 侧是 `init-wizard.ts` 与 `doctor.ts`。

---

## 测试

```bash
# 运行测试（根目录单份 Jest 配置，覆盖三个包）
npm test

# 测试覆盖率
npm run test:coverage

# 单个测试文件（本仓库 ESM，必须带 --experimental-vm-modules，
# 直接 `npx jest <file>` 会报 "Cannot use import statement outside a module"）
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts

# 代码关系分析测试
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/code-relations.spec.ts

# 跨文件 Import 解析测试
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/import-resolver.spec.ts

# core 边界守护 + DSH 对外契约冻结
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/core-boundary.spec.ts
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/public-surface.spec.ts

# ADR 模块测试
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/adr-frontmatter.spec.ts
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/adr-chunker.spec.ts
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/adr-anchor-index.spec.ts
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/adr-service.spec.ts
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/adr-indexer.spec.ts
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/adr-tools.spec.ts
node --experimental-vm-modules node_modules/.bin/jest packages/dsh/test/constraint-injector.spec.ts

# MCP server 冒烟测试（会拉起构建产物走真实 stdio，需先构建）
npm run build && node --experimental-vm-modules node_modules/.bin/jest packages/codex/test/mcp-smoke.spec.ts
```

---

## 开发

```bash
# 安装（peer 冲突说明见下）
npm install --legacy-peer-deps

# 按依赖顺序构建三个包：core → dsh → codex
npm run build

# 类型检查（先构建 core：适配器通过 core 的 dist/*.d.ts 解析类型）
npm run typecheck

# 运行测试（带详细输出）
node --experimental-vm-modules node_modules/.bin/jest --no-cache --verbose
```

`@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-settings` 对 `@deepseek-ai/dsh-brand` 的版本要求互斥，所以 npm 必须带 `--legacy-peer-deps`（或 `npm ci --legacy-peer-deps`）。这问题在拆分 workspace 之前就存在，与拆分无关。

---

## 依赖

core（`packages/core` → `dsh-context-milvus-core`）：

- [@zilliz/milvus2-sdk-node](https://github.com/milvus-io/milvus-sdk-node) — Milvus Node.js SDK
- `ignore` — gitignore 风格模式匹配
- `tree-sitter` — AST 解析引擎
- `tree-sitter-typescript` — TypeScript/JSX 语法
- `tree-sitter-python` — Python 语法
- `tree-sitter-java` — Java 语法
- `tree-sitter-go` — Go 语法
- `tree-sitter-rust` — Rust 语法
- `tree-sitter-c` — C 语法
- `tree-sitter-cpp` — C++ 语法
- `tree-sitter-c-sharp` — C# 语法
- `tree-sitter-scala` — Scala 语法

DSH 适配器（`packages/dsh`，均由 DSH 运行时提供）：

- `@deepseek-ai/cordis` — DSH 框架
- `@deepseek-ai/dsh-tools` — DSH 工具注册 API
- `@deepseek-ai/schemastery` — 配置 schema 定义
- `@deepseek-ai/dsh-settings` — 设置面板（`installSection`）
- `@deepseek-ai/dsh-llm` — 约束重注入使用的 agent 入口

Codex 适配器（`packages/codex`）：

- `@modelcontextprotocol/sdk` — MCP server + stdio 传输
- `zod` — MCP 工具入参 schema（刻意不进 core）

---

## License

MIT