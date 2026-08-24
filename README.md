# dsh-context-remdb

DSH 插件：通过 [RemDB](https://github.com/bobjia/remdb-server) 向量数据库实现语义代码搜索，支持完整的索引 ↔ 搜索闭环。

## 功能

- **`search_code`** — 语义搜索代码：输入自然语言查询，返回匹配的代码片段
- **`index_code`** — 索引代码仓库：AST 解析 + 分块 → Embedding → 存储到 RemDB
- **`index_status`** — 查看索引状态：文件数量、最后索引时间、哈希统计

## 安装到 DSH

### 1. 安装依赖

```bash
# 克隆/进入插件目录后
cd /mnt/home/bobjia/dsh-context-remdb
npm install --cache .npm-cache
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

### 3. 注册到 DSH Web Profile

```bash
# 进入 DSH Web Profile
cd ~/.dsh/profiles/web

# 安装插件为本地依赖
pnpm add file:/mnt/home/bobjia/dsh-context-remdb
```

### 4. 添加到 bundles

编辑 `~/.dsh/profiles/web/package.json`，在 `dsh.profile.bundles` 数组中追加：

```json
"dsh-context-remdb"
```

### 5. 配置插件

编辑 `~/.dsh/profiles/web/cordis.patch.yml`：

```yaml
- id: dsh-context-remdb
  config:
    remdbEndpoint: http://localhost:19530
    remdbCollection: code_embeddings
    remdbDim: 768
    embeddingEndpoint: http://localhost:19530/v2/vectordb/embedding
    embeddingModel: default
    indexRoot: /path/to/your/code
    hybridMode: true
```

## 配置项

### Cordis Config (通过 cordis.patch.yml 或 DSH Web GUI)

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `remdbEndpoint` | string | `http://localhost:19530` | RemDB 服务地址 |
| `remdbToken` | string (secret) | `""` | RemDB 鉴权 Token |
| `remdbCollection` | string | `code_embeddings` | 向量集合名称 |
| `remdbDim` | number | `768` | 向量维度 |
| `embeddingEndpoint` | string | `http://localhost:19530/v2/vectordb/embedding` | Embedding API 地址 |
| `embeddingApiKey` | string (secret) | `""` | Embedding API 密钥 |
| `embeddingModel` | string | `default` | Embedding 模型名称 |
| `indexRoot` | string | `""` | 代码仓库根路径 |
| `indexExtensions` | string | `""` | 索引的文件后缀 (逗号分隔) |
| `hybridMode` | boolean | `true` | 启用混合搜索 (BM25 + 向量) |
| `merkleFilePath` | string | `""` | Merkle 状态文件路径 |

### 环境变量 (fallback)

当 Cordis Config 未提供时，插件会读取环境变量：

```bash
export REMDB_ENDPOINT=http://localhost:19530
export REMDB_TOKEN=your-token
export REMDB_COLLECTION=code_embeddings
export REMDB_EMBEDDING_DIM=768
export EMBEDDING_ENDPOINT=http://localhost:19530/v2/vectordb/embedding
export EMBEDDING_API_KEY=your-key
export EMBEDDING_MODEL=default
export INDEX_ROOT=/path/to/code
export INDEX_EXTENSIONS=.ts,.tsx,.js,.py,.rs,.go,.java
export HYBRID_MODE=true
export MERKLE_FILE_PATH=~/.remdb-index/merkle.json
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

安装后，在 DSH Web 界面 (http://127.0.0.1:3080) 的 **Settings → Plugins** 中可以看到 `dsh-context-remdb` 及其配置表单，支持：

- 文本输入框 (普通字段)
- 密码输入框 (secret 字段，如 `remdbToken`、`embeddingApiKey`)
- 数值输入框 (number 字段，如 `remdbDim`)
- 开关 (boolean 字段，如 `hybridMode`)
- 字段说明/提示文本

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    DSH Agent / Web UI                        │
│  search_code  │  index_code  │  index_status                │
└───────────────┴──────────────┴──────────────────────────────┘
                        │
┌─────────────────────────────────────────────────────────────┐
│                  dsh-context-remdb                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌────────────┐  │
│  │ chunker  │→ │embedding │→ │  remdb   │  │  merkle    │  │
│  │(AST+regex)│  │  client  │  │ service  │  │  tracker   │  │
│  └──────────┘  └──────────┘  └──────────┘  └────────────┘  │
└─────────────────────────────────────────────────────────────┘
                        │
              ┌─────────┴─────────┐
              │                   │
        ┌──────────┐       ┌──────────┐
        │  RemDB   │       │Embedding │
        │  (向量库) │       │   API    │
        └──────────┘       └──────────┘
```

## 代码分块

| 语言 | 方法 | 说明 |
|------|------|------|
| TypeScript/JavaScript | Tree-sitter AST | 精确按函数/类/接口/枚举边界切分 |
| Python | 正则回退 | 检测函数/类/装饰器定义 |
| Rust | 正则回退 | 检测函数/impl/trait/struct/enum |
| Go | 正则回退 | 检测函数/类型声明 |
| Java | 正则回退 | 检测类/接口/方法声明 |

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
npx tsc --noEmit

# 运行测试
node --experimental-vm-modules node_modules/.bin/jest --no-cache --verbose
```

## 依赖

- [remdb-sdk-node](https://github.com/bobjia/remdb-sdk-node) — RemDB Node.js SDK
- `@deepseek-ai/cordis` — DSH 框架（由 DSH 运行时提供）
- `@deepseek-ai/dsh-tools` — DSH 工具注册 API（由 DSH 运行时提供）
- `@deepseek-ai/schemastery` — 配置 schema 定义（由 DSH 运行时提供）
- `tree-sitter` — AST 解析 (TypeScript/JavaScript)
- `tree-sitter-typescript` — TypeScript/JSX 语法

## License

MIT