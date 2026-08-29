# 为什么使用 dsh‑context‑milvus

`dsh‑context‑milvus` 是面向 **DeepSeek Harness（DSH）编码Agent** 的开源代码语义检索插件，底层使用 Milvus 做向量库，以 DSH 插件（Cordis Plugin）形式提供工具注册。核心目的：**解决原生 DSH Agent 仅靠 grep 字符串搜索带来的高 token 消耗、多轮工具调用、上下文污染、大型代码库理解差的问题**。

> 原生 DSH Agent 工作方式：遇到问题反复 `search_code`（grep）→ `read` 文件 → 再 search，大量无关文本灌入 prompt，工具调用爆炸，token 成本高，大仓库容易"找错代码、漏看依赖"。

## 1、解决原生 grep 检索的几大硬伤

| 原生 grep 模式痛点 | dsh‑context‑milvus 的解决方式 |
|---|---|
| 只能字面字符串匹配，语义相关但命名不同的代码找不到 | **向量语义检索**，按代码含义匹配，不是只匹配关键词 |
| 多轮工具调用，反复读一堆无关文件，token 暴涨 | 只召回真正相关的代码片段，通过 AST 按函数/类边界切分，精准命中 |
| 把大量 grep 输出、无关源码塞进上下文，造成**上下文失焦污染**，模型推理质量下降 | Milvus 预建索引，Agent 一次工具调用拿到精简有效上下文，不把检索中间噪音塞进 prompt |
| 大仓库上千文件，Agent 遍历效率极低 | Milvus 向量库做百万级代码块快速检索，支持增量更新代码索引，不用每次扫描整个仓库 |
| 只能搜索已打开的或已知路径的文件 | 全仓库索引后，可按语义搜索任何位置的相关代码，不依赖文件路径记忆 |

## 2、Milvus 在这里承担什么角色，为什么选 Milvus

1. **存储 AST 分块后的代码向量**：dsh‑context‑milvus 会用 tree-sitter AST 语法树把代码按函数/类/方法边界切分代码块，生成 embedding 存入 Milvus，避免把一个函数拦腰切断。
2. **高性能向量检索**：对 query 编码后做向量相似度检索，低延迟，适合 Agent 实时工具调用场景。
   > 注：BM25 关键词融合**尚未实现**，`hybridMode` 是预留开关——当前所有检索都是纯向量相似度。
3. **支持自托管 Milvus 实例 / Zilliz Cloud 托管版**，两种部署形态可选，团队可以管控数据；支持增量索引，代码变更后增量更新，不用全量重建索引。
4. **专门适配代码 RAG**：支持按路径范围过滤（`search_code` 的 `path` 参数），检索时可以限定目录，非常适合代码库场景。

## 3、DSH 插件架构带来的优势

它不是独立的 MCP 服务，而是作为 **DSH 插件**（Cordis Plugin）直接嵌入 DSH Agent 进程：

- **零额外网络开销**：插件与 Agent 同进程，工具调用不走 HTTP，延迟远低于 MCP
- **天然共享 DSH 资源配置**：复用 DSH 的配置管理、环境变量注入、日志系统，无需额外配置
- **DSH Web GUI 集成**：通过 Settings → Plugins 界面可视化配置，无需手写 YAML
- **DSH 生态兼容**：与其他 DSH 插件（bash、agent-loop、web-search 等）共享工具注册表，Agent 可自由组合调用

## 4、核心工作流程

### 注册的三个 DSH 工具

| 工具名 | 功能 | 关键参数 |
|--------|------|----------|
| `search_code` | 语义搜索代码 | `query`（自然语言查询）、`topK`（结果数）、`path`（搜索范围限定） |
| `index_code` | 索引代码仓库 | `mode`（full 全量 / incremental 增量）、`path`（指定路径） |
| `index_status` | 查看索引状态 | `path`（指定路径查看独立状态） |

### 工作流程

1. 执行 `index_code` 工具：解析项目，tree-sitter AST 拆分代码块 → 调用 Embedding 模型生成向量 → 存入 Milvus 集合。
2. Agent 遇到编码问题，调用 `search_code` 工具向 Milvus 发起**语义（向量）检索**。
3. Milvus 返回最相关的少量代码片段，注入 Agent 上下文。
4. Agent 基于精准上下文做调试、重构、开发，不再疯狂 grep 读一堆文件。
5. 代码变更后，执行 `index_code mode=incremental` 增量更新，只重新索引变更的文件。
6. 随时通过 `index_status` 查看索引状态（已索引文件数、代码块总数、最后索引时间）。

## 5、支持的 10 种语言

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

## 6、配置系统

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
| `hybridMode` | `HYBRID_MODE` | boolean | `true` | 预留开关，BM25 融合尚未实现（当前仅向量检索） |
| `indexIgnoreDirs` | `INDEX_IGNORE_DIRS` | string | dist, build, target, vendor, ... | 扫描时跳过的目录名 |
| `ignorePatterns` | `IGNORE_PATTERNS` | string (textarea) | 空 | 自定义 gitignore 风格忽略规则 |
| `merkleFilePath` | `MERKLE_FILE_PATH` | string | `~/.milvus-index/merkle-{name}-{hash}.json` | Merkle 状态文件路径 |

## 7、忽略规则系统（IgnoreMatcher）

三层 gitignore 风格的文件忽略规则，确保索引时只索引真正需要分析的代码文件：

### 三层规则

1. **内置默认规则**：自动排除 `node_modules/`、`dist/`、`build/`、`.git/`、`__pycache__/`、`*.log`、`*.min.js` 等常见构建产物和依赖目录
2. **代码库忽略文件**：自动读取 `.gitignore`、`.ignore`、`.xxxignore` 等文件
3. **全局忽略文件**：读取 `~/.context/.contextignore`（用户级全局规则）

### 自动隐藏路径保护

自动忽略以 `.` 开头的路径段（如 `.git/`、`.vscode/`、`.env`），防止隐藏目录和文件被误索引。

### 向后兼容

配置中的 `indexIgnoreDirs`（逗号分隔的目录名列表）会自动转换为 gitignore 风格模式（如 `dist` → `**/dist/**`），与旧版本兼容。

## 8、增量索引与工作区隔离

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

## 9、什么时候应该用，什么时候不建议

✅ **适合场景**

- 几十~百万行规模代码仓库，使用 DSH Agent 做重构、bug 定位、跨文件阅读；
- 希望降低 token 开销，减少 Agent 来回 grep 的工具循环；
- 需要开源可自托管，不想依赖闭源索引服务；
- 已在使用 DSH 框架，希望为 Agent 增强代码理解能力；
- 需要增量索引，代码频繁变更但不想每次全量重建。

❌ **不适合/注意点**

1. 需要 embedding API（OpenAI / Ollama 等），索引阶段代码片段会送给 embedding 服务；隐私要求极高可搭配 Ollama 本地 Embedding；
2. 多了 Milvus / Zilliz Cloud 依赖，增加运维复杂度；小仓库（几百文件以内）收益不明显；
3. 它是检索增强，**不能替代模型本身的上下文窗口**，只是筛选高质量上下文，解决"噪音过载"而不是无限放大窗口；
4. 需要 DSH 环境（v0.6+），不能独立于 DSH 运行。

## 对比简单自建代码 RAG

如果你自己写一套代码 RAG for DSH Agent：要处理 AST 分块、向量检索调参、增量同步代码变更、DSH 工具封装、结果排序、忽略文件系统；dsh‑context‑milvus 已经把这套工程全部封装好，开箱即用，专门针对代码场景调优过。

| 对比维度 | 自建代码 RAG | dsh‑context‑milvus |
|----------|-------------|-------------------|
| AST 分块 | 自行集成 tree-sitter，每种语言单独配置 | 内置 10 种语言 tree-sitter 分块，自动回退到 regex |
| 语义检索 | 自行调用 embedding 服务并调参 | 内置向量语义检索，开箱即用（BM25 融合暂未实现） |
| 增量索引 | 自行实现文件哈希对比和状态管理 | 内置 Merkle 文件状态追踪，SHA-256 哈希，增量更新 |
| 工作区隔离 | 自行处理多工作区状态冲突 | 自动基于路径哈希隔离，互不干扰 |
| 忽略文件 | 自行实现 .gitignore 解析 | 内置三层忽略规则系统（默认 + 代码库 + 全局） |
| DSH 工具封装 | 自行封装 DSH 工具（defineTool） | 3 个原生 DSH 工具，一键注册，含输出格式化 |
| 配置界面 | 自行实现或手写 YAML | DSH Web GUI 可视化配置，13 个配置字段 |
| 配置来源 | 单一来源 | 三源合并（Cordis Config > 环境变量 > 默认值） |
| 索引状态 | 自行实现查看 | 内置 `index_status` 工具，实时查看索引状态 |

### 一句话总结

> dsh‑context‑milvus = **给 DSH Agent 装上一套代码库专用语义检索引擎，Milvus 负责高速向量语义检索，把"大海捞针式 grep"变成"精准召回相关代码片段"，降 token、减工具调用、提升大仓库下编码 Agent 质量**。