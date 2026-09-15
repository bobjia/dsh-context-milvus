---
title: c-language-support
type: spec
created: 2026-09-16
status: draft
id: SPEC-2026-09-16-c-language-support
related_decisions: []
---

# C 语言支持（dsh-context-milvus）

## 概要

为 `dsh-context-milvus` 的代码检索内核（core 包）新增 **C 语言**索引支持：以 tree-sitter AST 分块为主，regex 回退为辅，与现有 C++ 的处理方式一致。FPGA（Verilog/VHDL/SystemVerilog）支持不在本次范围内，后续单独规划。

## 背景与约束

### 可行性已验证

- `tree-sitter-c@0.23.6` 已作为 `tree-sitter-cpp` 的传递依赖存在于 `node_modules`，实测可与当前 tree-sitter 运行时（0.25.1）正常 `setLanguage` 并解析 C 代码。
- npm 上 `tree-sitter-c` 最新版为 0.24.1，将声明为 core 包的直接依赖，脱离对 tree-sitter-cpp 的隐式传递依赖。
- C 语法关键 AST 节点实测可用：`function_definition`、`struct_specifier`、`enum_specifier`、`union_specifier`、`type_definition`、`preproc_function_def`、`preproc_include`、`call_expression`、`field_expression`、`identifier`。

### 必须修复的既有缺陷

现有 `extractNodeName`（`chunker.ts`）与 `deriveExportsFromChunks`（`import-resolver.ts`）中的名字提取逻辑对 C 的 AST 结构取不到正确名字：

- `int add(int a, int b) { ... }` → `childForFieldName('type')` 取到返回类型 `int`，而不是函数名 `add`。
- `typedef struct { ... } Point;` → 匿名 `struct_specifier` 取不到 `Point`。

C 的 `function_definition` 名字藏在 `declarator` 字段 → `function_declarator` → `identifier` 中。两处逻辑需一起修复（同一份代码逻辑存在两份拷贝）。

### 扩展名冲突决策（已与用户确认）

`.h` 头文件目前归 C++（`cpp: ['.cpp', '.cxx', '.cc', '.hpp', '.h', '.hh']`）。纯 C 项目也使用 `.h`，二者存在歧义。**决策：`.h` 保持归 C++，仅新增 `.c` 扩展名归 C**。理由：

- 最小改动，不破坏现有 C++ 项目索引。
- C++ 语法树能解析绝大多数 C 头文件；纯 C 特有语法（`_Generic`、`restrict` 等）会产生 ERROR 节点，但不影响索引与检索。
- 后续如需 `.h` 归属可配置化，作为独立增强另行设计。

## 非目标

- FPGA/HDL（Verilog、VHDL、SystemVerilog）支持 —— 用户明确延后。
- `.h` 头文件归属可配置化。
- DSH/Codex 适配器改动 —— 本设计只改 core 包，适配器零改动自动获得 C 支持。

## 设计

### 1. 依赖：`packages/core/package.json`

新增直接依赖 `tree-sitter-c`（`^0.23.6`，与已安装的传递依赖版本一致；新装环境解析到 0.24.x 亦兼容）。

### 2. 语言定义：`packages/core/src/chunker.ts`

在 `LANGUAGES` 数组新增：

```ts
{
  config: {
    name: 'c',
    extensions: ['.c'],
    chunkNodeTypes: [
      'function_definition',
      'struct_specifier',
      'enum_specifier',
      'union_specifier',
      'type_definition',
      'preproc_function_def',
    ],
    referenceNodeTypes: ['call_expression', 'field_expression', 'identifier'],
    importNodeTypes: ['preproc_include'],
    resolveImportPath: (importPath, sourceFile) => {
      // #include "foo.h" → 同目录 foo.h（与 cpp 相同）
      if (!importPath) return null
      const dir = path.dirname(sourceFile)
      return path.resolve(dir, importPath)
    },
  },
  loadTs: () => require('tree-sitter-c'),
}
```

要点：

- `type_definition` 覆盖 `typedef struct { ... } Point;` 匿名 struct typedef。
- `preproc_function_def` 覆盖 `#define SQUARE(x) ...` 函数宏（C 中常见的"API"形态）。
- **不包含** `declaration`（普通变量声明），避免把每个声明都切成一块（cpp 已有的噪音问题，C 不继承）。

### 3. 修复名字提取（两处同步）

**`chunker.ts` 的 `extractNodeName`** 与 **`import-resolver.ts` 的 `deriveExportsFromChunks`**，在现有字段查询后追加 `declarator` 字段兜底：

```ts
// 现有：name → type → identifier
// 追加：declarator → 递归取标识符
const declarator = node.childForFieldName('declarator')
if (declarator) {
  const id = declarator.childForFieldName('declarator') ?? declarator
  // function_declarator → 再取 declarator；type_definition → type_identifier
  const inner = id.childForFieldName('declarator') ?? id
  const nameNode = inner.childForFieldName('name') ??
    inner.childForFieldName('identifier') ??
    inner.namedChildren.find(c => ['identifier', 'type_identifier'].includes(c.type))
  if (nameNode) return nameNode.text
}
```

这是对现有语言的兼容扩展（不影响 TS/JS/Python/C++ 等的现有行为），不是重写。

### 4. regex 回退：`REGEX_PATTERNS.c` + `regexChunkType` 分支

参考现有 cpp 正则：

```ts
c: [
  // 函数：static int add(int a, int b) ...
  /^(?:(?:static|inline|extern|const|volatile|unsigned|signed|long|short|char|int|float|double|void|struct|union|enum|size_t|ssize_t|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t|int64_t|uint64_t)\s+)*(?:\w+(?:\s*\*|\s*&)?\s+)?(\w+)\s*\(/gm,
  /^struct\s+(\w+)/gm,
  /^union\s+(\w+)/gm,
  /^enum\s+(\w+)/gm,
  /^typedef\s+.+?\s(\w+)\s*;/gm,   // typedef ... Point;
],
```

`regexChunkType` 增加 `c` 分支：`struct` → `struct_specifier`、`union` → `union_specifier`、`enum` → `enum_specifier`、`typedef` → `type_definition`，其余 → `function_definition`。

### 5. 默认扩展名：`packages/core/src/config.ts`

`DEFAULT_EXTENSIONS` 增加：

```ts
c: ['.c'],
```

### 6. 文档更新

- `CLAUDE.md`「Supported languages」表新增 C 行。
- `README.md` / `README.zh.md`「Code Chunking」表新增 C 行，并更新「除 PHP 外均可 regex 回退」的枚举说明（如需提及 C）。
- 依赖清单部分新增 `tree-sitter-c`。

## 错误处理

- tree-sitter 解析失败 → 自动降级到 regex 回退（与 Python/Java/Go/Rust/C++/C#/Scala 一致）。
- 无 regex 模式命中 → 返回空数组，不报错（与现有行为一致）。
- `#include` 路径解析失败 → 返回 null，跳过该导入边（复用 import-resolver 现有逻辑）。

## 测试

新增 `packages/core/test/chunker-c.spec.ts`（或并入现有 chunker spec），覆盖：

1. **tree-sitter 路径**：C 函数 chunk 的 `name` 为 `add`（而非 `int`）；`struct`/`enum`/`union` 名字正确；`typedef struct {...} Point;` 取到 `Point`；`#define SQUARE(x)` 宏函数成块。
2. **引用提取**：`call_expression`、`field_expression`（`p.x`）被收集。
3. **import 解析**：`#include "myutil.h"` → `preproc_include` → 解析到同目录 `myutil.h`（import-resolver spec 中验证）。
4. **regex 回退**：强制走 regex 路径时函数/结构体/枚举仍能成块且名字正确。
5. **回归**：现有语言（TS/JS/Python/C++）的名字提取不受 `extractNodeName` 改动影响。

测试遵循仓库惯例：core spec 直接 import 源码（`../../core/src/chunker.js`），不触碰 Milvus SDK。

## 验收标准

1. `packages/core/src/chunker.ts` 的 `getSupportedExtensions()` 包含 `.c`。
2. 索引一个含 `.c` 文件的目录，chunks 的 `language` 为 `c`，函数 chunk 的 `name` 正确。
3. `#include` 跨文件引用可被 import-resolver 解析。
4. `npm test`（或 `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/chunker-c.spec.ts`）全部通过。
5. 文档（CLAUDE.md / README / README.zh）语言表含 C。
