# dsh-context-milvus

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/bobjia/dsh-context-milvus)

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
- **混合检索** — BM25 关键词 + 向量语义双路检索，RRF 融合，`hybridMode` 控制开关
- **忽略模式系统** — 三层 gitignore 风格忽略规则（默认模式 + 代码库忽略文件 + 全局忽略文件）
- **增量索引** — 基于 Merkle SHA-256 哈希追踪，仅处理变更文件
- **工作区隔离** — 不同工作区使用独立的 Merkle 状态文件，互不干扰

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

### 工作流程

1. 执行 `index_code` 工具：解析项目，tree-sitter AST 拆分代码块 → 调用 Embedding 模型生成向量 → 存入 Milvus 集合。
2. Agent 遇到编码问题，调用 `search_code` 工具向 Milvus 发起**混合检索**（向量语义 + BM25 关键词，RRF 融合）。
3. Milvus 返回最相关的少量代码片段，注入 Agent 上下文。
4. Agent 基于精准上下文做调试、重构、开发，不再疯狂 grep 读一堆文件。
5. 代码变更后，执行 `index_code mode=incremental` 增量更新，只重新索引变更的文件。
6. 随时通过 `index_status` 查看索引状态（已索引文件数、代码块总数、最后索引时间）。

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

### 快速安装（DSH CLI）

```bash
# 安装到 web 配置
dsh plugin --profile web add dsh-context-milvus

# 或安装到自定义配置
dsh plugin --profile <profile-name> add dsh-context-milvus
```

> 此命令会从 npm 源安装插件并自动注册到指定 profile，重启 DSH 后生效。

### 从 Git 安装（未发布 npm 时）

```bash
dsh plugin --profile web add git+https://github.com/bobjia/dsh-context-milvus.git
```

> `dist/` 产物不提交到 git，插件通过 `prepare` 脚本在安装时自动运行 `tsc`
> 生成构建产物；安装端需要有可用的 TypeScript（devDependencies）。
>
> 注意：pnpm 10 默认会阻止依赖执行构建脚本。若安装报
> `entry file missing: ./dist/plugins/dsh-context-milvus/index.js`，
> 需要允许该依赖运行构建脚本——在 DSH 插件项目的 `pnpm-workspace.yaml` 中
> 添加 `onlyBuiltDependencies`，或在项目目录运行 `pnpm approve-builds`
> 并勾选 `dsh-context-milvus`，然后重新安装。

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
# 进入 DSH 配置文件目录
cd ~/.dsh/profiles/<profile-name>

# 安装插件为本地依赖
pnpm add file:/mnt/home/bobjia/workspace/dsh-context-milvus
```

#### 4. 添加到 bundles

编辑 `~/.dsh/profiles/<profile-name>/package.json`，在 `dsh.profile.bundles` 数组中追加：

```json
"dsh-context-milvus"
```

#### 5. 配置插件

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

索引代码仓库。支持两种模式：

- **`full`** — 全量索引所有文件
- **`incremental`** — 增量索引（仅处理变更文件，基于 Merkle 哈希）

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `mode` | string | 否 | `incremental` | 索引模式：`full` 或 `incremental` |
| `path` | string | 否 | (配置的根路径) | 要索引的路径 |

### `index_status`

查看索引状态，包括文件数量、代码块总数、最后索引时间等。

---

## 代码分块

| 语言 | 扩展名 | 分块方式 | 覆盖的 AST 节点类型 |
|------|--------|----------|--------------------|
| TypeScript | .ts, .tsx, .mts, .cts | tree-sitter | function_declaration, method_definition, class_declaration, interface_declaration, enum_declaration, type_alias_declaration, arrow_function, generator_function, getter, setter |
| JavaScript | .js, .jsx, .mjs, .cjs | tree-sitter | function_declaration, method_definition, class_declaration, arrow_function, generator_function, getter, setter |
| Python | .py | tree-sitter + regex 回退 | function_definition, class_definition, async_function_definition, decorated_definition |
| Java | .java | tree-sitter + regex 回退 | class_declaration, interface_declaration, enum_declaration, method_declaration, constructor_declaration, record_declaration |
| Go | .go | tree-sitter + regex 回退 | function_declaration, method_declaration, type_declaration, type_spec |
| Rust | .rs | tree-sitter + regex 回退 | function_item, impl_item, trait_item, struct_item, enum_item, macro_definition |
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
| DSH 工具封装 | 自行封装 DSH 工具（defineTool） | 3 个原生 DSH 工具，一键注册，含输出格式化 |
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
┌──────────────────────────────────────────────────────────────┐
│                    DSH Agent / Web UI                         │
│  search_code  │  index_code  │  index_status                 │
└───────────────┴──────────────┴───────────────────────────────┘
                        │
┌──────────────────────────────────────────────────────────────┐
│                  dsh-context-milvus                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ chunker  │→ │embedding │→ │  milvus  │  │  merkle    │  │
│  │(AST+regex)│  │  client  │  │ service  │  │  tracker   │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
│                        ▲                                     │
│  ┌────────────────────────────────────────────────────────┐  │
│  │  ignore-matcher (gitignore-style 三层忽略系统)          │  │
│  │  ① DEFAULT_IGNORE_PATTERNS → ② 代码库忽略文件          │  │
│  │  ③ ~/.context/.contextignore                           │  │
│  └────────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────────┘
                        │
              ┌─────────┴─────────┐
              │                   │
        ┌──────────┐       ┌──────────┐
        │  Milvus  │       │Embedding │
        │ (向量库) │       │   API    │
        └──────────┘       └──────────┘
```

### 模块依赖关系

```
index.ts (entry point)
  ├── config.ts     — 配置解析（Cordis config > 环境变量 > 默认值）
  │     └── DEFAULT_IGNORE_PATTERNS — 内置 gitignore 风格忽略规则
  ├── milvus-service.ts — Milvus 向量数据库客户端封装（CRUD、搜索）
  │     └── embedding.ts — OpenAI 兼容 Embedding API 客户端
  ├── merkle.ts     — SHA-256 哈希追踪器（增量索引，持久化到 JSON）
  ├── tools.ts      — DSH 工具定义、格式化、工作区感知的追踪器创建
  ├── ignore-matcher.ts — gitignore 风格模式匹配（文件排除）
  └── indexer.ts    — 索引管线编排
        └── chunker.ts — tree-sitter AST 分块 + regex 回退
```

---

## 测试

```bash
# 运行测试
npm test

# 测试覆盖率
npm run test:coverage

# 单个测试文件
npx jest test/dsh-context-remdb.spec.ts
```

---

## 开发

```bash
# 编译
npm run build

# 类型检查（不输出）
npx tsc --noEmit

# 运行测试（带详细输出）
node --experimental-vm-modules node_modules/.bin/jest --no-cache --verbose
```

---

## 依赖

- [@zilliz/milvus2-sdk-node](https://github.com/milvus-io/milvus-sdk-node) — Milvus Node.js SDK
- `ignore` — gitignore 风格模式匹配
- `tree-sitter` — AST 解析引擎
- `tree-sitter-typescript` — TypeScript/JSX 语法
- `tree-sitter-python` — Python 语法
- `tree-sitter-java` — Java 语法
- `tree-sitter-go` — Go 语法
- `tree-sitter-rust` — Rust 语法
- `tree-sitter-cpp` — C++ 语法
- `tree-sitter-c-sharp` — C# 语法
- `tree-sitter-scala` — Scala 语法
- `@deepseek-ai/cordis` — DSH 框架（由 DSH 运行时提供）
- `@deepseek-ai/dsh-tools` — DSH 工具注册 API（由 DSH 运行时提供）
- `@deepseek-ai/schemastery` — 配置 schema 定义（由 DSH 运行时提供）

---

## License

MIT