---
title: cross-file-import-resolution
type: spec
created: 2026-09-03
status: draft
id: SPEC-2026-09-03-cross-file-import-resolution
related_decisions: [SPEC-2026-09-02-code-relationship-analysis]
---

# 跨文件 Import 精确解析（Code Relationship Analysis V2）

## 概要

在 V1（名称匹配，`json_contains`）的基础上，为每个代码文件解析 import/export 语句，构建 **Import Map**，实现跨文件引用精确匹配——解决 V1 同名函数混淆的问题。

## 架构总览

```text
索引时 (index_code):
  import-resolver.ts 扫描每个文件的 import/export 语句
    → 构建 Import Map（JSON 文件，与 Merkle 状态并列存储）
    → 增量更新：只处理变更文件

查询时 (find_callers / trace_call_chain):
  V1: json_contains(references, symbol) → 候选集
  V2: Import Map 过滤候选集 → 按定义文件分组 / 精确限定
    → 无 map 时自动降级 V1
```

## Import Map 数据结构

### 存储格式

```json
{
  "imports": {
    "src/app.ts": {
      "parseConfig": { "target": "src/config.ts", "exportedAs": "parseConfig" },
      "initDb": { "target": "src/db.ts", "exportedAs": "initDb" }
    }
  },
  "exports": {
    "src/config.ts": ["parseConfig", "setupLogger"],
    "src/db.ts": ["initDb", "connect", "close"]
  }
}
```

- **`imports`**：key = `(importerFile, symbol)`，value = 定义文件 + 导出的符号名
- **`exports`**：key = `targetFile`，value = 该文件导出的所有符号（用于反向查找时缩小候选集）

### 存储位置

与 Merkle 状态文件并列，路径为 `import-map-{workspaceHash}.json`，通过 `deriveMerkleFilePath` 类似机制生成。

## import-resolver.ts 模块

### 核心接口

```typescript
export interface ImportEntry {
  target: string      // 解析后的绝对路径
  exportedAs: string  // 目标文件导出的符号名
}

export interface ImportMap {
  imports: Record<string, Record<string, ImportEntry>>
  exports: Record<string, string[]>
}

export class ImportResolver {
  constructor(mapPath: string)
  load(): Promise<void>
  save(): Promise<void>
  scanFile(filePath: string, content: string, ext: string): void
  removeFile(filePath: string): void
  resolve(filePath: string, symbol: string): ImportEntry | null
  getExports(filePath: string): string[]
  isImportedFrom(filePath: string, symbol: string, targetFile: string): boolean
  getStats(): { filesWithImports: number; totalEdges: number }
}
```

### 增量更新

与 Merkle HashTracker 相同的增量逻辑——`index_code` 计算出 `toIndex` / `toRemove` 后：
- `toIndex` 中的文件：调用 `scanFile` 重新提取 import/export
- `toRemove` 中的文件：调用 `removeFile` 清理
- 最后 `save()` 持久化

## 每语言 import/export 配置

### LanguageConfig 扩展

```typescript
interface LanguageConfig {
  name: string
  extensions: string[]
  chunkNodeTypes: string[]
  referenceNodeTypes?: string[]
  // NEW for V2:
  importNodeTypes?: string[]
  exportNodeTypes?: string[]
  resolveImportPath?: (importPath: string, sourceFile: string) => string | null
}
```

### 完整配置表

| 语言 | importNodeTypes | exportNodeTypes | 路径解析 |
|------|----------------|----------------|----------|
| **TypeScript** | `import_statement` | `export_statement` | `'./foo'` → `./foo.ts` → `.tsx` → `.js` → `/index.ts` |
| **JavaScript** | `import_statement` | `export_statement` | 同上（无 `.ts`） |
| **Python** | `import_from_statement`, `import_statement` | 从 `chunkNodeTypes` 推导（顶级定义，排除 `_` 前缀） | `from .foo import` → `./foo.py`; `from foo import` → 当前包内 `./foo.py` |
| **Go** | `import_declaration` | 从 `chunkNodeTypes` 推导（首字母大写） | `import "pkg"` → `./pkg/`（目录级，package-level） |
| **Java** | `import_declaration` | 从 `chunkNodeTypes` 推导（public 定义） | `import com.example.Foo` → `./com/example/Foo.java` |
| **Rust** | `use_declaration` | 从 `chunkNodeTypes` 推导（`pub` 定义） | `use crate::module::func` → `./module.rs`; `use super::module` → `../module.rs` |
| **C++** | `preproc_include` | 从 `chunkNodeTypes` 推导（头文件中的非 static 声明） | `#include "header.hpp"` → `./header.hpp` + 搜索包含目录 |
| **C#** | `using_directive` | 从 `chunkNodeTypes` 推导（public 定义） | `using Project.Namespace` → `./Project/Namespace/`（目录级） |
| **Scala** | `import` | 从 `chunkNodeTypes` 推导（public 定义） | `import com.example.Foo` → `./com/example/Foo.scala` |
| **PHP** | 无（regex 回退） | 无 | 跳过 |

### 无显式 export 语言的导出推导

Python/Go/Java/Rust/C++/C#/Scala 没有统一的 `export` 关键字。这些语言的导出符号从已有的 `chunkNodeTypes` 推导——`chunkNodeTypes` 已经覆盖了所有顶级定义节点（函数、类、接口等），从中提取名称即为此文件导出的符号。

## 查询集成

### find_callers — 隐式消歧（默认）

```
1. V1 查询: json_contains(references, symbol) → 候选集
2. 对每个候选 chunk，查 import map: imports[candidateFile][symbol]
   → 有结果: resolved，按 target 文件分组
   → 无结果: 查 exports[candidateFile] 是否有 symbol → local（同文件调用）
   → 都无: unresolved，回退 V1 行为
3. 返回分组结果，每组标注定义文件
```

### find_callers — 显式 sourceFile

```
1. V1 查询拿到候选集
2. 过滤: 保留 imports[candidateFile][symbol].target === sourceFile 的 chunk
3. 如果 candidateFile === sourceFile（同文件内部调用），也保留
```

### trace_call_chain — 复合键消歧

BFS 的搜索符号从裸符号名改为 `filePath:symbol` 复合键。每个节点携带 `filePath` 作为定义文件限定，下一层展开时：

- **backward**：`find_callers` 返回的 chunk 中，取其 `name` + 该 chunk 的 `filePath` 作为 `filePath:name` 复合键入队
- **forward**：从 `references` 取下一层符号时，用 import map 解析每个引用指向的文件，生成 `targetFile:symbol` 复合键

### 降级回退

- `resolve: false` 参数 → 完全不加载 import map，完全 V1 行为
- import map 不存在（首次运行）→ 自动降级 V1，提示 `"Import map not found, falling back to name-based matching. Run index_code first for exact resolution."`

## 工具参数扩展

### find_callers

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `symbol` | string | 是 | — | 要查找的符号名 |
| `direction` | enum | 否 | `backward` | 影响/依赖方向 |
| `maxResults` | number | 否 | 20 | 最大返回数 |
| `sourceFile` | string | 否 | — | 限定定义文件（显式消歧） |
| `resolve` | boolean | 否 | `true` | 是否启用 import 解析 |

### trace_call_chain

| 参数 | 类型 | 必填 | 默认 | 说明 |
|------|------|------|------|------|
| `entry` | string | 是 | — | 入口符号名 |
| `direction` | enum | 否 | `backward` | 展开方向 |
| `maxDepth` | number | 否 | 3 | 最大递归深度 |
| `maxResults` | number | 否 | 10 | 每层最大结果数 |
| `resolve` | boolean | 否 | `true` | 是否启用 import 解析 |

### 返回格式扩展

每个 chunk 新增 `resolution` 字段：

```typescript
{
  filePath: "src/app.ts",
  content: "...",
  startLine: 42,
  endLine: 68,
  chunkType: "function_declaration",
  name: "runApp",
  resolution: {
    status: "resolved",          // "resolved" | "local" | "unresolved"
    targetFile: "src/config.ts", // resolved 时：定义文件
    exportedAs: "parseConfig",   // resolved 时：导出的符号名
  }
}
```

渲染标注：
- `✓ (resolved)` — 精确匹配
- `(local)` — 同文件调用
- `⚠ (unresolved, matched by name)` — 回退名称匹配

## 错误处理与边界情况

| 场景 | 处理 |
|------|------|
| import map 文件不存在 | 自动降级为 V1，提示信息 |
| import map 过期 | 下次 `index_code` 增量更新修复 |
| 同名本地定义 + 同名 import | import map 优先 |
| 循环 import | `scanFile` 不递归，不存在循环 |
| 路径解析失败 | `resolveImportPath` 返回 `null`，标记 `unresolved` |
| 动态 import / `require()` | 不做解析，标记 `unresolved` |
| `export * from` 重导出 | 不做传递解析 |
| 超大 import map | 异步加载，Map O(1) 查找，`getStats()` 监控 |
| `resolve: false` | 完全不加载 import map，零开销，等于 V1 |

## 测试策略

| 层级 | 内容 |
|------|------|
| 单元测试 | `import-resolver.ts`：mock 文件内容，验证 import 解析、路径解析、增量更新、查询方法 |
| 集成测试 | `code-relations.spec.ts` 扩展：创建含 import 关系的测试文件 → `index_code` → 验证 `find_callers` 隐式消歧和显式 `sourceFile` 过滤 |
| 每语言解析 | 每种语言写一个 import 解析测试 |
| 降级回退 | `resolve: false` 完全等于 V1；无 import map 自动降级 |
| 回归 | 现有 216 个测试不变 |

## 不包含在 V2 中的内容

- tsconfig `paths` 别名解析
- `node_modules` 包解析
- `export * from` 重导出链追溯
- 动态 `import()` 解析
- 可视化调用链图
- 同源合并（同一文件连续行引用合并为一条）