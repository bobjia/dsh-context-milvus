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

### 扩展名补充决策（`.inc`）

**决策：`.inc` 归 C**（用户要求）。注意 `.inc` 并非 C 独有 —— GitHub Linguist 将其同时归入 C++、Assembly（NASM 等汇编 include 文件常用 `.inc`）、BitBake、NASL。在纯 C/C++ 嵌入式项目中 `.inc` 通常是 C 头文件片段；若项目同时含汇编 `.inc`，会被 C 语法解析出 ERROR 节点，但不影响索引。C 相关候选扩展名（`.i` GCC 预处理产物、`.h.in` autoconf 模板、`.idc` IDA 脚本、`.l`/`.y` lex/yacc、`.cu` CUDA、`.m` Objective-C）本次均**不加入**——或为构建产物/小众格式，或为独立语言，避免误伤。

### 头文件函数原型分块（补充决策）

C 头文件（`.c` 之外还有 `.inc`）中的函数声明 `int helper(void);` 在 tree-sitter-c 中是 `declaration` 节点（内含 `function_declarator`），不是 `function_definition`。若只按 chunkNodeTypes 分块，头文件里的 API 原型将无法被索引。**决策：`declaration` 进入 chunkNodeTypes，但通过新增的 `chunkNodeFilter` 只保留含 `function_declarator` 的声明（函数原型），过滤普通变量声明**（如 `extern int global_count;`、`static int counter;`）。

## 非目标

- FPGA/HDL（Verilog、VHDL、SystemVerilog）支持 —— 用户明确延后。
- `.h` 头文件归属可配置化。
- `.i`/`.h.in`/`.idc`/`.l`/`.y`/`.cu`/`.m` 等候选扩展名 —— 见「扩展名补充决策」。
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
    extensions: ['.c', '.inc'],
    chunkNodeTypes: [
      'function_definition',
      'struct_specifier',
      'enum_specifier',
      'union_specifier',
      'type_definition',
      'preproc_function_def',
      'declaration',
    ],
    // 只保留含 function_declarator 的 declaration（函数原型），过滤普通变量声明
    chunkNodeFilter: (node: any) =>
      node.type !== 'declaration' ||
      node.descendantsOfType('function_declarator').length > 0,
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
- `declaration` 覆盖头文件中的函数原型（`int helper(void);`），**通过 `chunkNodeFilter` 只保留含 `function_declarator` 的声明**，普通变量声明（`extern int global_count;` 等）不切块 —— 避免 cpp 已有的 `declaration` 噪音问题。

### 2b. `LanguageConfig` 类型扩展：`packages/core/src/types.ts`

新增可选字段 `chunkNodeFilter`，与 `chunkNodeTypes` 配合使用：

```ts
export interface LanguageConfig {
  name: string
  extensions: string[]
  chunkNodeTypes: string[]
  chunkNodeFilter?: (node: any) => boolean  // NEW: 仅对通过过滤的节点切块
  referenceNodeTypes?: string[]
  importNodeTypes?: string[]
  exportNodeTypes?: string[]
  resolveImportPath?: (importPath: string, sourceFile: string) => string | null
}
```

该过滤同时应用于两处（保证 chunk 与 export 推导一致）：
- `chunker.ts` 的 `chunkWithTreeSitter`：`collectChunks` 结果按 `chunkNodeFilter` 过滤。
- `import-resolver.ts` 的 `deriveExportsFromChunks`：遍历 chunk 节点时应用同一过滤。

### 3. 修复名字提取（两处同步）

**`chunker.ts` 的 `extractNodeName`** 与 **`import-resolver.ts` 的 `deriveExportsFromChunks`**，调整字段查询顺序并沿 `declarator` 字段链取名字：

**关键点：`declarator` 必须在 `type` 之前检查** —— C 的 `function_definition` 的 `type` 字段是返回类型（`int add(...)` → type=`int`），若先查 `type` 会取到 `int` 而不是 `add`。

```ts
function extractNodeName(node: any): string {
  const nameNode = node.childForFieldName('name')
  if (nameNode) return nameNode.text

  // C/C++: 名字在 declarator 字段链上（必须在 type 之前检查！
  // function_definition → declarator=function_declarator → declarator=identifier
  // type_definition     → declarator=type_identifier（直接就是名字）
  const declarator = node.childForFieldName('declarator')
  if (declarator) {
    let current: any = declarator
    while (current) {
      const t = current.type
      if (t === 'identifier' || t === 'type_identifier' || t === 'field_identifier') {
        return current.text
      }
      const next = current.childForFieldName('declarator')
      if (!next) break
      current = next
    }
    // 兜底：取最近的 identifier/type_identifier 后代
    const ids = declarator.descendantsOfType('identifier')
    const tids = declarator.descendantsOfType('type_identifier')
    const fallback = ids[0] ?? tids[0]
    if (fallback) return fallback.text
  }

  const typeNode = node.childForFieldName('type')
  if (typeNode) return typeNode.text

  const identifierNode = node.childForFieldName('identifier')
  if (identifierNode) return identifierNode.text

  for (const child of node.namedChildren) {
    const t = child.type
    if (t === 'identifier' || t === 'type_identifier' || t === 'property_identifier') {
      return child.text
    }
  }
  return `anonymous_${node.type}`
}
```

这是对现有语言的兼容扩展（TS/JS/Python/C++ 等的 `name` 字段路径不受影响；C++ 的 `declaration`/`function_definition` 名字反而被顺带修正），不是重写。

实测验证（tree-sitter-c 0.23.6）：
- `static int add(int a, int b)` → `add`（而非 `int`）
- `typedef struct { int x; int y; } Point;` → `Point`（type_definition）
- `int helper(void);` → `helper`（declaration 原型）
- `int (*callback)(int);` → `callback`（函数指针声明）

### 4. regex 回退：`REGEX_PATTERNS.c` + `regexChunkType` 分支

参考现有 cpp 正则（与 `packages/core/src/chunker.ts` 实现逐字一致）：

```ts
  c: [
    // function: static int add(int a, int b) { ... }
    /^(?:(?:static|inline|extern|const|volatile|register)\s+)*(?:unsigned|signed|long|short|char|int|float|double|void|struct|union|enum|size_t|ssize_t|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t|int64_t|uint64_t|const\s+\w+|\w+)\s+(?:[*&]\s*)?(\w+)\s*\(/gm,
    /^struct\s+(\w+)/gm,
    /^union\s+(\w+)/gm,
    /^enum\s+(\w+)/gm,
    /^typedef\s+.*\b(\w+)\s*;$/gm,
  ],
```

`regexChunkType` 的 `c` 分支（与实现一致）：

```ts
  if (language === 'c') {
    if (/^struct\s/.test(line)) return 'struct_specifier'
    if (/^union\s/.test(line)) return 'union_specifier'
    if (/^enum\s/.test(line)) return 'enum_specifier'
    if (/^typedef\s/.test(line)) return 'type_definition'
    return 'function_definition'
  }
```

### 5. 默认扩展名：`packages/core/src/config.ts`

`DEFAULT_EXTENSIONS` 增加：

```ts
c: ['.c', '.inc'],
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
2. **头文件原型**：`int helper(void);` 在 `.inc` 文件里成块（`declaration` + `chunkNodeFilter`），`name` 为 `helper`；`extern int global_count;` 等普通声明**不**成块。
3. **`.inc` 扩展名**：`chunkCode('/tmp/x.inc', ...)` 走 C 解析，`language` 为 `c`。
4. **引用提取**：`call_expression`、`field_expression`（`p.x`）被收集。
5. **import 解析**：`#include "myutil.h"` → `preproc_include` → 解析到同目录 `myutil.h`（import-resolver spec 中验证）。
6. **regex 回退**：tree-sitter 不可用时函数/结构体/枚举仍能成块且名字正确。
7. **回归**：现有语言（TS/JS/Python/C++）的名字提取不受 `extractNodeName` 改动影响。

测试遵循仓库惯例：core spec 直接 import 源码（`../../core/src/chunker.js`），不触碰 Milvus SDK。

## 验收标准

1. `packages/core/src/chunker.ts` 的 `getSupportedExtensions()` 包含 `.c` 与 `.inc`。
2. 索引一个含 `.c`/`.inc` 文件的目录，chunks 的 `language` 为 `c`，函数 chunk 的 `name` 正确。
3. `#include` 跨文件引用可被 import-resolver 解析。
4. `npm test`（或 `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/chunker-c.spec.ts`）全部通过。
5. 文档（CLAUDE.md / README / README.zh）语言表含 C。
