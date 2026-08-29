# dsh-context-milvus

DSH 插件：通过 **Milvus** 向量数据库实现语义代码搜索，支持完整的索引 ↔ 搜索闭环。

## 功能

- **`search_code`** — 语义搜索代码：输入自然语言查询，返回匹配的代码片段
- **`index_code`** — 索引代码仓库：AST 解析 + 分块 → Embedding → 存储到 Milvus
- **`index_status`** — 查看索引状态：文件数量、最后索引时间、哈希统计
- **混合检索** — BM25 关键词 + 向量语义双路检索，RRF 融合，`hybridMode` 控制开关
- **忽略模式系统** — 三层 gitignore 风格忽略规则（默认模式 + 代码库忽略文件 + 全局忽略文件）

## 安装到 DSH

### 1. 安装依赖

```bash
cd /mnt/home/bobjia/workspace/dsh-context-milvus
npm install --legacy-peer-deps
```

### 2. 创建 @deepseek-ai 包的符号链接

```bash
# 链接 DSH 运行时的包（npm install 可能破坏这些链接）
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/cordis \
  node_modules/@deepseek-ai/cordis
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools \
  node_modules/@deepseek-ai/dsh-tools
ln -sf /mnt/home/bobjia/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/schemastery \
  node_modules/@deepseek-ai/schemastery
```

### 3. 注册到 DSH

```bash
# 进入 DSH 配置文件目录
cd ~/.dsh/profiles/<profile-name>

# 安装插件为本地依赖
pnpm add file:/mnt/home/bobjia/workspace/dsh-context-milvus
```

### 4. 添加到 bundles

编辑 `~/.dsh/profiles/<profile-name>/package.json`，在 `dsh.profile.bundles` 数组中追加：

```json
"dsh-context-milvus"
```

### 5. 配置插件

编辑 `~/.dsh/profiles/<profile-name>/cordis.patch.yml`：

```yaml
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

## 配置项

### Cordis Config（通过 cordis.patch.yml 或 DSH Web GUI）

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `milvusAddress` | string | `localhost:19530` | Milvus 服务地址 |
| `milvusToken` | string (secret) | — | Milvus 鉴权 Token |
| `milvusCollection` | string | `code_embeddings` | 向量集合名称 |
| `milvusDim` | number | `768` | 向量维度 |
| `embeddingEndpoint` | string | `http://localhost:11434/api/embed` | Embedding API 地址 |
| `embeddingApiKey` | string (secret) | — | Embedding API 密钥 |
| `embeddingModel` | string | `nomic-embed-text` | Embedding 模型名称 |
| `indexRoot` | string | `process.cwd()` | 代码仓库根路径 |
| `indexExtensions` | string | *(见支持语言表)* | 索引的文件后缀 (逗号分隔) |
| `hybridMode` | boolean | `true` | 启用混合检索（BM25 全文 + 向量语义，RRF 融合） |
| `bm25RrfK` | number | `60` | 混合检索 RRF 融合参数 k |
| `indexIgnoreDirs` | string | *(内置默认值)* | 忽略的目录名 (逗号分隔，向后兼容) |
| `ignorePatterns` | string | *(内置默认值)* | 自定义忽略模式 (gitignore 风格，逗号分隔) |
| `merkleFilePath` | string | *(自动生成)* | Merkle 状态文件路径 |

### 环境变量 (fallback)

当 Cordis Config 未提供时，插件会读取环境变量：

```bash
export MILVUS_ADDRESS=localhost:19530
export MILVUS_TOKEN=your-token
export MILVUS_COLLECTION=code_embeddings
export MILVUS_EMBEDDING_DIM=768
export EMBEDDING_ENDPOINT=http://localhost:11434/api/embed
export EMBEDDING_API_KEY=your-key
export EMBEDDING_MODEL=nomic-embed-text
export INDEX_ROOT=/path/to/code
export INDEX_EXTENSIONS=.ts,.tsx,.js,.py,.java,.go,.rs,.cpp,.cs,.scala,.php
export HYBRID_MODE=true
export BM25_RRF_K=60
export INDEX_IGNORE_DIRS=dist,build,target,__pycache__
export IGNORE_PATTERNS=*.log,*.min.js
export MERKLE_FILE_PATH=~/.milvus-index/merkle.json
```

## 工具说明

### `search_code`

语义搜索代码。当用户提出模糊的功能需求、询问代码逻辑或需要根据自然语言描述查找代码时自动调用。

**参数：**

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `query` | string | 是 | — | 用户的自然语言查询 |
| `topK` | number | 否 | 5 | 返回最相关的结果数量 |

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

查看索引状态，包括文件数量、最后索引时间、哈希统计等。

## DSH Web 界面配置

安装后，在 DSH Web 界面 (http://127.0.0.1:3080) 的 **Settings → Plugins** 中可以看到 `dsh-context-milvus` 及其配置表单，支持：

- 文本输入框 (普通字段)
- 密码输入框 (secret 字段，如 `milvusToken`、`embeddingApiKey`)
- 数值输入框 (number 字段，如 `milvusDim`)
- 开关 (boolean 字段，如 `hybridMode`)
- 字段说明/提示文本

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

## 代码分块

| 语言 | 扩展名 | 分块方法 |
|------|--------|----------|
| TypeScript | `.ts`, `.tsx`, `.mts`, `.cts` | tree-sitter AST |
| JavaScript | `.js`, `.jsx`, `.mjs`, `.cjs` | tree-sitter AST |
| Python | `.py` | tree-sitter AST |
| Java | `.java` | tree-sitter AST |
| Go | `.go` | tree-sitter AST |
| Rust | `.rs` | tree-sitter AST |
| C++ | `.cpp`, `.cxx`, `.cc`, `.hpp`, `.h`, `.hh` | tree-sitter AST |
| C# | `.cs` | tree-sitter AST |
| Scala | `.scala` | tree-sitter AST |
| PHP | `.php` | 正则回退 |

## 忽略模式系统

三层 gitignore 风格忽略规则，用于控制索引时排除的文件：

1. **默认模式** — 内置 `DEFAULT_IGNORE_PATTERNS`，覆盖 `node_modules/**`、`.git/**`、`dist/**`、`build/**`、`*.log` 等 30+ 条模式
2. **代码库忽略文件** — 自动读取代码库根目录下的 `.gitignore`、`.ignore`、`.xxxignore` 文件
3. **全局忽略文件** — 从 `~/.context/.contextignore` 读取全局忽略规则

向后兼容：原有的 `indexIgnoreDirs` 配置项自动转换为 `**/dirname/**` 模式。

## 测试

```bash
# 运行测试
npm test

# 测试覆盖率
npm run test:coverage
```

## 开发

```bash
# 编译
npm run build

# 类型检查（不输出）
npx tsc --noEmit

# 运行测试（带详细输出）
node --experimental-vm-modules node_modules/.bin/jest --no-cache --verbose
```

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

## License

MIT