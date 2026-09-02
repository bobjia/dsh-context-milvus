---
title: code-relationship-analysis
type: spec
created: 2026-09-02
status: draft
id: SPEC-2026-09-02-code-relationship-analysis
code_anchors:
  - file: src/plugins/dsh-context-milvus/chunker.ts
    symbols: [extractNodeName, chunkWithTreeSitter, collectChunks]
    lines: [242, 258, 270]
  - file: src/plugins/dsh-context-milvus/milvus-service.ts
    symbols: [createCollectionWithSchema, createCodeCollection, searchCode]
    lines: [136, 216, 260]
  - file: src/plugins/dsh-context-milvus/types.ts
    symbols: [CodeChunk, SearchResult]
    lines: [6, 17]
  - file: src/plugins/dsh-context-milvus/tools.ts
    symbols: [registerSearchCodeTool, registerIndexCodeTool]
    lines: [100, 220]
  - file: src/plugins/dsh-context-milvus/indexer.ts
    symbols: [runIndex]
    lines: [1, 50]
---

# 代码关系分析（Code Relationship Analysis）

## 概要

在现有 dsh-context-milvus 基础设施上，为每个代码 chunk 附带存储「引用了哪些符号」，在此基础上提供两个新能力：

1. **修改影响分析**：给定一个符号（函数/变量/类），反向查找所有引用它的代码位置，递归扩展得到传递闭包——回答「改了 X 会影响谁」
2. **调用链追踪**：从入口符号开始，沿引用关系双向 BFS 展开，输出调用链树——回答「某个功能的上下游调用关系」

## 架构总览

```text
索引时 (index_code):
  chunker.ts 解析 AST ──→ 提取 chunk {name, content, chunkType}
                         + 新增: references: string[]

  milvus-service.ts ──→ code_embeddings 集合
                         enable_dynamic_field: true 自动存储 references

查询时:
  find_callers(symbol, direction, maxResults)
    ──→ Milvus 表达式过滤: json_contains(references, symbol)
    ──→ 返回引用该符号的所有 chunk

  trace_call_chain(entry, direction, maxDepth, maxResults)
    ──→ BFS 逐层 find_callers
    ──→ visited set 防止
    ──→ maxDepth 默认 3
```

### 不变的部分

- 增量索引管道（Merkle hash → delta → insert/delete）
- Milvus 连接与 gRPC 客户端
- 工具注册框架（`defineTool` + `ctx.tools.register`）
- 配置项（`indexRoot`、`adrEnabled` 等）
- 现有 205 个测试全部通过

## 引用提取（chunker.ts 扩展）

### 提取规则

| AST 节点类型 | 示例 | 提取的符号 | 语言通用性 |
|---|---|---|---|
| `call_expression` | `parseConfig(args)` | `"parseConfig"` | 所有语言 |
| `import_statement` / `import` | `import { X } from '...'` | `"X"` | TS/JS/Go/Python/Java |
| `require` | `require('./foo')` | `"foo"` | TS/JS |
| `member_expression` | `this.foo()` | `"this.foo"` | TS/JS/Java/C++/C# |
| `assignment` | `x = y` | `"x"`, `"y"` | 所有语言 |
| 标识符引用 | `await svc.start()` | `"svc"`, `"svc.start"` | 所有语言 |

### 提取流程

每次 `chunkWithTreeSitter` 解析一个 chunk 节点后，在其 AST 子树内遍历子节点，收集以下类型的标识符：

1. `call_expression` 的 `function` 子节点 → 函数名
2. `member_expression` 的完整路径（如 `this.foo`、`obj.bar`）
3. `import` 语句的绑定名
4. `identifier` 类型的子节点（排除语言关键字和单字母变量）

### 去噪策略

- 排除语言关键字集合（`return`, `const`, `if`, `for`, `while`, `switch`, `case`, `break`, `continue`, `throw`, `try`, `catch`, `finally`, `async`, `await`, `yield`, `new`, `typeof`, `instanceof`, `void`, `delete`, `import`, `export`, `default`, `from`, `as`, `in`, `of`）
- 排除单字母变量名（`i`, `j`, `k`, `x`, `y`, `n`, `e`, `_`）
- 同一个 chunk 内去重（Set）
- 维护可配置停用词表（`data`, `config`, `result`, `process`, `error`, `value`, `item`, `args`, `options`, `tmp`, `temp`, `key`, `val`, `name`, `type`, `size`, `length`, `index`, `count`, `total`, `status`, `msg`, `err`）

### 语言支持

为每种语言扩展 `referenceNodeTypes` 配置：

```typescript
interface LanguageDef {
  config: LanguageConfig
  loadTs?: () => any | Promise<any>
  referenceNodeTypes?: string[]  // NEW: 引用节点类型
}
```

TypeScript 的引用节点类型：
```typescript
referenceNodeTypes: [
  'call_expression',
  'import_statement',
  'import_specifier',
  'member_expression',
  'identifier',
]
```

其他语言（Python/Go/Java/Rust 等）各自映射对应的 AST 节点类型。正则回退语言（PHP）不做引用提取。

## 存储（code_embeddings 扩展）

### 字段定义

利用 `enable_dynamic_field: true`，在插入时附带 `references` 字段：

```typescript
// 插入数据结构
{
  file_path: 'src/plugins/dsh-context-milvus/tools.ts',
  code_content: 'function findCallers(...) { ... }',
  start_line: 100,
  end_line: 120,
  language: 'typescript',
  chunk_type: 'function_declaration',
  name: 'findCallers',
  references: ['searchCode', 'jsonContains', 'formatResults'],  // JSON 数组
}
```

### 查询方法

```typescript
// Milvus 表达式过滤（使用 query 而非 search，避免向量距离计算）
const filter = `json_contains(references, "${symbol}")`

const results = await client.query({
  collection_name: 'code_embeddings',
  expr: filter,
  output_fields: ['file_path', 'code_content', 'start_line', 'end_line', 'chunk_type', 'name'],
  limit: maxResults,
})
```

**为什么用 query 而非 search**：引用查找是精确符号匹配，不是语义相似度。`query()` 做纯属性过滤，无需向量距离计算，速度更快且结果可预测。

### 不新建独立集合的理由

- 引用关系是 chunk 的附属元数据，随 chunk 一起插入/删除，增量更新逻辑保持简单
- 查询时拿到引用者 chunk 后，其 `name`（函数名）就是下一层 BFS 的搜索符号，不需要额外 join
- 避免 3-15 倍的行数膨胀（每个 chunk 的引用集直接存储）

## 查询引擎

### find_callers

```typescript
find_callers(symbol: string, direction?: 'backward' | 'forward', maxResults?: number)
```

**backward 模式（默认）**——「谁引用了我」= 影响面：
1. 构造 `json_contains(references, symbol)` 表达式
2. 查询 `code_embeddings`，返回所有引用该符号的 chunk
3. 去重（同一个 (filePath, startLine) 只返回一次）
4. 按 score 排序（BM25 相关性）

**forward 模式**——「我引用了谁」= 依赖面：
1. 查找 `name == symbol` 的所有 chunk（可能有多个定义位置，如重载或同名函数）
2. 合并所有匹配 chunk 的 `references` 数组（它调用的下游符号，去重）
3. 如果多个同名 chunk 分布在不同的文件，分别标注文件路径

### trace_call_chain

```typescript
trace_call_chain(entry: string, direction?: 'backward' | 'forward', maxDepth?: number, maxResults?: number)
```

BFS 算法：

```
1. visited = new Set<string>()
   queue = [{symbol: entry, depth: 0}]
   chain = []

2. 从 queue 出队当前符号
   visited.add(current.symbol)

3. 如果 direction == 'backward':
     callers = find_callers(current.symbol, 'backward', maxResults)
     // 从每个 caller chunk 提取其 name 作为下一层搜索符号
     对每个 caller: 如果 caller.name 不在 visited 中，入队
   如果 direction == 'forward':
     callees = find_callers(current.symbol, 'forward', maxResults)
     // 从 references 中提取下一层符号
     对每个 callee: 如果不在 visited 中，入队

4. depth++，如果 depth <= maxDepth 且 queue 非空，回到步骤 2

5. 返回 chain 树
```

**去环**：visited set 记录已访问符号，遇到环自动截断。

**结果结构**：
```typescript
{
  chain: [
    { depth: 0, symbol: "main", filePath: "src/index.ts", startLine: 1, endLine: 30, callers: [...] },
    { depth: 1, symbol: "runApp", filePath: "src/app.ts", startLine: 10, endLine: 25, callers: [...] },
    { depth: 2, symbol: "initConfig", filePath: "src/config.ts", startLine: 5, endLine: 15, callers: [] },
  ]
}
```

## 工具定义

### find_callers

注册于 `tools.ts`，遵循现有 `defineTool()` 模式：

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `symbol` | string | 是 | — | 要查找的符号名 |
| `direction` | enum | 否 | `backward` | `backward`=谁引用了我，`forward`=我引用了谁 |
| `maxResults` | number | 否 | 20 | 每层最大返回数 |

输出：`{ chunks: [{ filePath, symbol, content, startLine, endLine, chunkType, name }] }`

渲染：按文件分组的列表，每行标注行号范围。

### trace_call_chain

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `entry` | string | 是 | — | 入口符号名 |
| `direction` | enum | 否 | `backward` | `backward`=影响分析（找调用者），`forward`=依赖分析（找被调用者） |
| `maxDepth` | number | 否 | 3 | 最大递归深度 |
| `maxResults` | number | 否 | 10 | 每层最大结果数 |

输出：`{ chain: [{ depth, symbol, filePath, startLine, endLine, callers: [...] }] }`

渲染：缩进树形结构，每层显示符号 + 文件路径 + 行号。

## 跨文件引用解析（V2）

### 目标

将 `import { parseConfig } from './config'` 解析为确定性映射：`parseConfig → { file: "src/config.ts", line: 42 }`。

### 实现策略

1. 文件扫描时，对每个文件提取 import/require 语句，构建 `importMap: Map<symbol, {sourceFile, targetFile, exportedSymbol}>`
2. 对每个目标文件，解析其 exports（`export function` / `export const` / `export default` / `module.exports`）
3. 建立反向映射：引用符号 → 定义文件 + 行号
4. 查询时优先使用确定性映射；无映射时回退到名称匹配

### V1 vs V2 分界

| 能力 | V1（MVP） | V2（完整） |
|------|-----------|-----------|
| 引用提取 | ✅ AST 节点级别 | ✅ 同上 |
| 跨文件查找 | ✅ 名称匹配（json_contains 自然命中） | ✅ 确定性路径解析 |
| 通用名去噪 | ✅ 停用词表 | ✅ 扩展停用词表 |
| 调用链渲染 | ✅ 缩进树 | ✅ 缩进树 + 文件链接 |
| import 解析 | ❌ 不实现 | ✅ 完整实现 |

V1 先交付，V2 迭代。V1 对独特名称（如 `findCallers`、`createAdrCollection`）精确度足够；通用名（`process`、`data`）有噪声，但停用词表可缓解。

## 错误处理与边界情况

| 场景 | 处理 |
|------|------|
| 符号不存在 | 返回空结果，工具正常退出 |
| 通用名噪声 | 内置停用词表，可通过 config 扩展 |
| 循环引用（A→B→C→A） | BFS visited set 自动截断，深度不超 maxDepth |
| 大返回集 | maxResults 限制，超出时截断并提示 |
| 未索引的代码 | 提示 `"code_embeddings not found or empty. Run index_code first."` |
| 跨文件符号未解析 | 回退到名称匹配，结果中标注 `(unresolved, matched by name)` |
| 仅单字母匹配 | 排除单字母，只返回空结果 |
| 同一 chunk 引用自身 | 不被提取（`references` 中排除等于 `name` 的符号） |

## 测试策略

### 单元测试

- BFS 算法：已知图结构，验证遍历顺序和去环
- 去噪逻辑：停用词过滤、单字母排除、关键字排除
- 引用提取：对已知 AST 结构，验证提取的 references 集合正确

### 集成测试

- 在 `test/adr-tools.spec.ts` 或新建 `test/code-relations.spec.ts` 中：
  - 创建含引用关系的测试文件 → 运行 `index_code` → 验证 `find_callers` 返回正确结果
  - 验证 `trace_call_chain` 多级扩展正确
  - 验证 `backward` 和 `forward` 两个方向

### 回归测试

- 确保现有 205 个测试不因 `references` 动态字段增加而失败
- `enable_dynamic_field: true` 保证向后兼容

## 与 ADR/Spec 锚点系统的协同

`find_callers` 的查询结果（受影响文件列表）可以自然地作为 `search_adr_by_file` 的输入，从而将代码级影响面升级为决策级影响面：

```
修改 foo.ts
  → find_callers("foo") → [bar.ts, baz.ts, qux.ts]
  → search_adr_by_file("bar.ts") → ADR-0003, ADR-0005
  → search_adr_by_file("baz.ts") → SPEC-2026-09-01-lazy-eval
  → 输出: "修改 foo 会影响 3 个文件，关联 2 个 ADR 和 1 个 spec"
```

但这不是自动行为——由 Agent 按需组合调用，不做硬耦合。

## 实现计划

### 预计工作量

| 阶段 | 任务 | 依赖 | 预估 |
|------|------|------|------|
| T1 | types.ts: 扩展 LanguageDef 加 referenceNodeTypes | 无 | 小 |
| T2 | chunker.ts: 提取 references | T1 | 中 |
| T3 | milvus-service.ts: 查询时表达式过滤支持 | 无 | 小 |
| T4 | tools.ts: 注册 find_callers 和 trace_call_chain | T2, T3 | 中 |
| T5 | 去噪逻辑（停用词表 + 关键字过滤 + 单字母排除） | T2 | 小 |
| T6 | 测试 | T1-T5 | 中 |
| T7 | 文档（AGENTS.md 更新） | T6 | 小 |

### 不包含在 V1 中的内容

- 跨文件 import 解析（V2）
- 同源合并（同一文件连续行引用合并为一条）
- 可视化调用链图（仅文本输出）