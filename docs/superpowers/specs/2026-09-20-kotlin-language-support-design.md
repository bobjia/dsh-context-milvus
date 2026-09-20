---
title: kotlin-language-support
type: spec
created: 2026-09-20
status: draft
id: SPEC-2026-09-20-kotlin-language-support
related_decisions: []
---

# Kotlin 语言支持（dsh-context-milvus）

## 概要

为 `dsh-context-milvus` 的代码检索内核（core 包）新增 **Kotlin** 索引支持：`.kt` 与 `.kts` 两个扩展名，**tree-sitter AST 分块**（grammar 包 `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0`），不提供 regex 回退（与 TypeScript/JavaScript 同款策略）。

用户诉求的原始表述是「把 `.kt`/`.kts` 加进索引扩展名列表」。需要说清一件事：**只改扩展名列表不是可用的改法**——见「背景与约束」第 1 节。本设计同时注册扩展名与语言定义。

## 背景与约束

### 1. 扩展名列表与语言注册是两处，只改前者会静默失败

- `packages/core/src/config.ts` 的 `DEFAULT_EXTENSIONS` 决定 **walk 哪些文件**（`walkDirectory` 按 `extSet` 过滤）。
- `packages/core/src/chunker.ts` 的 `EXT_MAP`（由 `LANGUAGES` 构建）决定 **怎么分块**。

若只把 `.kt`/`.kts` 加进 `DEFAULT_EXTENSIONS`，这些文件会被 walk 到、读入并计算哈希，但 `chunkCode` 会在 `EXT_MAP` 查不到扩展名时抛 `Unsupported file extension: .kt`；`indexer.ts` 的 per-file `catch` 把它计入 `failedFiles` 并打印「失败: …」，最终**零 chunk 入库**。因此本设计以「注册成完整语言」为口径。

### 2. 可行性已实测（不是纸面推断）

在临时目录安装 `@tree-sitter-grammars/tree-sitter-kotlin@1.1.0` 后实测：

- `setLanguage` + `parse` 在仓库现有 `tree-sitter@0.25.1` 下**成功**，无原生编译（包内 `prebuilds/` 已覆盖 `darwin-arm64` / `darwin-x64` / `linux-arm64` / `linux-x64` / `win32-arm64` / `win32-x64`）。
- 该包 `peerDependencies` 声明 `tree-sitter: ^0.22.4`。这与仓库既有的 `tree-sitter-scala@0.24.0`（声明 `^0.21.1`，实际跑在 0.25.1 且工作正常）属同一类宽松声明；**实测可用**，故接受该 peer 范围。
- 选择 `@tree-sitter-grammars/*` 组织下的包而非旧的 `tree-sitter-kotlin`（fwcd，最新 0.3.8，peer 声明 `^0.21.0`）：前者是活跃维护的社区 fork，且 1.1.0 的 prebuilds 与本机 Node 22 / linux-x64 直接匹配。

### 3. 关键 AST 事实（实测，决定设计细节）

| Kotlin 语法 | 节点类型 | `name` 字段 |
|---|---|---|
| `fun add() {}`、`fun String.shout()` | `function_declaration` | ✅ 有 |
| `class` / `data class` / `sealed class` / `enum class` / `interface` | `class_declaration` | ✅ 有 |
| `object Foo {}` | `object_declaration` | ✅ 有 |
| `companion object {}` | `companion_object` | — |
| `constructor(...)`（次级构造） | `secondary_constructor` | — |
| `val` / `var` / `const val` | `property_declaration` | ❌ **永远为 null** |
| `typealias Handler = ...` | `type_alias` | ❌ 无 `name`，但首个 named child 是 `identifier` |

三处「不顺手的实测结论」，都会影响实现：

1. **`property_declaration` 没有 `name` 字段**。绑定名在其 `variable_declaration` 子节点的 `identifier` 里：`const val NAME = "a"` → `property_declaration` → `variable_declaration` → `identifier`(`NAME`)。注意有修饰符时首个 named child 是 `modifiers` 节点（内容为 `const`），所以**不能**靠「取第一个 named child」拿名字——`extractNodeName` 现有的兜底循环只认 `identifier`/`type_identifier`/`property_identifier` 三类直接子节点，也拿不到，会退化成 `anonymous_property_declaration`。
2. **`call_expression` 没有 `function` 字段**。被调用者是第一个 named child：`add(1,2)` → children 为 `identifier`(`add`) + `value_arguments`；`Greeter("a").greet()` → children 为 `navigation_expression` + `value_arguments`。现有 `extractSymbolFromNode` 对 `call_expression` 走的是 `childForFieldName('function')`，对 Kotlin 恒为 null。
3. **`import` 节点没有 `path` 字段**。`import com.example.Foo` 的 named children 只有 `qualified_identifier`；`import com.example.Bar as B` 额外带一个 `identifier`（别名）。`import-resolver.ts` 里 `case 'import'` 是 Scala 分支（用 `childForFieldName('path')`），Kotlin 复用它会静默解析出 0 条边。

### 4. 已知粗糙点（记入风险，不在本次修复）

- **单行类体解析失败**：`class A { fun f() {} }`（声明与嵌套函数同行、且函数体为空）会产生 `ERROR` 节点；多行写法（真实代码的常态）解析干净。ERROR 节点不会导致文件被跳过——`chunkWithTreeSitter` 仍按可用节点切块，只是该文件少几块。
- `.kts` 脚本（实测）：`plugins { kotlin("jvm") version "1.9.0" }` → 顶层 `call_expression`；`@file:JvmName("X")` → `file_annotation`。均可解析，脚本里的顶层 `val` 也能成块。

## 非目标

- **regex 回退**：不新增 `REGEX_PATTERNS.kotlin` 与 `regexChunkType` 分支。Kotlin 与 TypeScript/JavaScript 同属「无回退」策略：grammar 加载失败时 `chunkCode` 落到 `chunkWithRegex`，因无模式而返回空数组，文件零 chunk 且不报错。
- **修复上游 grammar 的单行类体 ERROR**（见「已知粗糙点」）。
- **精确的 Kotlin 包根/源码根探测**：`resolveImportPath` 沿用 Java/Scala 的 `dirname(dirname(sourceFile))` 约定（假定文件位于源码根下两层），不做 `src/main/kotlin` 之类的布局自适应，也不做文件系统存在性检查。
- **更完整的 Kotlin import 语义**：星号导入（`import com.example.util.*`）**直接跳过**（不产生名为 `*` 的符号，也不做批量符号展开），`package_header` 不解析。
- **DSH/Codex 适配器行为改动**：本设计只改 core 包；适配器零改动自动获得 Kotlin 支持。
- **`packages/dsh/package.json` 的 grammar 依赖列表**：该列表未随 C 支持（`tree-sitter-c`）同步，属既有陈旧残留；本次沿用同样做法只改 core，不顺手清理（见「设计 1」）。

## 设计

### 1. 依赖：`packages/core/package.json`

新增 `@tree-sitter-grammars/tree-sitter-kotlin: ^1.1.0`，并刷新根 `package-lock.json`。

**只在 core 声明**：`packages/dsh/package.json` 里那份 grammar 列表（`tree-sitter-scala` 等 8 项）是历史副本——C 支持只改了 core，DSH 因为 npm workspaces 提升（也可经由 `dsh-context-milvus-core` 的依赖）照样能解析到 grammar。Kotlin 沿用同一路径，保持与 C 支持一致；若日后要清理由此产生的列表漂移，作为独立改动处理。

### 2. 扩展名：`packages/core/src/config.ts`

```ts
kotlin: ['.kt', '.kts'],
```

两个扩展名同属一个语言条目。不存在与现有扩展名的归属冲突（现有列表里没有 `.kt`/`.kts`）。

### 3. 语言定义：`packages/core/src/chunker.ts`

在 `LANGUAGES` 数组新增：

```ts
{
  config: {
    name: 'kotlin',
    extensions: ['.kt', '.kts'],
    chunkNodeTypes: [
      'function_declaration',
      'class_declaration',
      'object_declaration',
      'companion_object',
      'secondary_constructor',
      'property_declaration',
      'type_alias',
    ],
    // 顶层/类体的 val·var 才成块；函数体内的局部变量（parent 为 block）不成块
    chunkNodeFilter: (node: any) =>
      node.type !== 'property_declaration' ||
      node.parent?.type === 'source_file' ||
      node.parent?.type === 'class_body',
    referenceNodeTypes: ['call_expression', 'navigation_expression', 'identifier', 'import'],
    importNodeTypes: ['import'],
    resolveImportPath: (importPath: string, sourceFile: string) => {
      // import com.example.Foo → <上层目录>/com/example/Foo.kt
      // 与 java / scala 分支同一约定（假定文件位于源码根下两层）
      if (!importPath) return null
      const srcDir = path.dirname(path.dirname(sourceFile))
      const filePath = importPath.replace(/\./g, '/') + '.kt'
      return path.resolve(srcDir, filePath)
    },
  },
  loadTs: () => require('@tree-sitter-grammars/tree-sitter-kotlin'),
}
```

要点：

- `class_declaration` 一个节点类型覆盖 class / data class / sealed class / enum class / **interface**（grammar 不区分 `interface_declaration`），无需额外条目。
- `property_declaration` 必须配 `chunkNodeFilter`：`chunkNodeTypes` 由 `collectChunks` 在**整棵树**上收集（深度上限 10），不加过滤会把每个函数体内的局部 `val` 都切成 chunk，制造大量噪音。过滤同时作用于 `chunkWithTreeSitter` 与 `import-resolver` 的 `deriveExportsFromChunks`（后者已有 `chunkNodeFilter` 调用），所以「chunk」与「export 推导」口径一致。
- 不含 `primary_constructor`：`val x: Int` 参数已被 `class_declaration` 的 chunk 文本覆盖，单独成块只会产生重复内容。
- `loadTs` 用同步 `require`（该包 `main` 为 CJS `bindings/node`），与 `tree-sitter-scala` 同款；不需要 `tree-sitter-c-sharp` 那种 `await import(...)` 形式。
- 同步更新文件头注释里「tree-sitter 覆盖语言」的清单（现为 `TypeScript/JavaScript/Python/Java/Go/Rust/C/C++/C#/Scala`）。

### 4. 名字提取：`property_declaration` 与 `type_alias`

`type_alias` **无需改动**：`extractNodeName` 的末段兜底循环匹配 `identifier` 直接子节点，实测能取到 `Handler`。

`property_declaration` 需要新逻辑。为遵守 C 支持建立的「同一份逻辑只留一份共享 helper」约定（`extractDeclaratorName` 即如此），在 `chunker.ts` 新增并导出：

```ts
/**
 * Kotlin: `property_declaration` has no `name` field — the binding lives in the
 * `variable_declaration` child's `identifier`. Modifiers (`const val NAME`) add a
 * `modifiers` node as the first named child, so "first named child" is not a name.
 * Shared by extractNodeName (chunker) and deriveExportsFromChunks (import-resolver).
 */
export function extractVariableBindingName(node: any): string | null {
  const varDecl = node.namedChildren?.find((c: any) => c.type === 'variable_declaration')
  if (!varDecl) return null
  const ident = varDecl.namedChildren?.find((c: any) => c.type === 'identifier')
  return ident ? ident.text : null
}
```

- `chunker.ts` 的 `extractNodeName`：在 `name` 字段检查之后、`extractDeclaratorName` 之前插入该分支。
- `import-resolver.ts` 的 `deriveExportsFromChunks`：在 `nameNode` 检查之后、`extractDeclaratorName(node)` 之前插入同一调用，保持两处一致。

两处插入点都不影响现有语言（TS/JS/Python/Java/Go/Rust/C/C++/C#/Scala/PHP 均无 `property_declaration` 节点）。

### 5. 引用提取：无需改动 `extractSymbolFromNode`（实现期修正）

**实现期修正**：本设计最初要求给 `extractSymbolFromNode` 的 `call_expression` 补「无 `function` 字段时取第一个 named child」的兜底，并新增 `navigation_expression` 分支。实测证伪了这一必要性：

- Kotlin 的调用名已经由 `identifier` 节点覆盖（`referenceNodeTypes` 含 `'identifier'`）：`add(1, 2)` → `identifier`(`add`)；`Greeter("a").greet()` → `identifier`(`Greeter`) + `identifier`(`greet`)；`service.load()` → `identifier`(`service`) + `identifier`(`load`)。
- 现有 `call_expression` 分支对 Kotlin 恒返回 null（无 `function` 字段），恰恰意味着它**不产生噪音**；`navigation_expression` 不在 switch 的 case 列表里，走 default 同样返回 null。

因此 `extractSymbolFromNode` 保持原样。补那两个分支只会把已收集到的符号再推导一遍（零新增收益），同时把 `?? node.namedChildren?.[0]` 这个兜底塞进所有语言共用的抽取逻辑，徒增回归面。`packages/core/test/dsh-context-remdb.spec.ts` 的 `collects Kotlin call references without expression noise` 用例作为行为护栏保留。

实测证据（`fun main()` 内的调用集合）：`identifiers in chunk: main, x, add, println, Greeter, greet, service, load`，且 `call_expression` 的 `function` 字段全为 null。

### 6. import 解析：`import-resolver.ts`

新增 Kotlin 分支（**不能**复用 Scala 的 `case 'import'`，见「关键 AST 事实」第 3 条）：从 `import` 节点取第一个 named child（`qualified_identifier`）作为导入路径；若存在第二个 `identifier`（`as` 别名），符号名取别名，否则取路径最后一段。

```ts
case 'import': {
  // Scala: `path` field. Kotlin: no field — first named child is the qualified_identifier
  const pathNode = node.childForFieldName('path') ?? node.namedChildren?.[0]
  ...
}
```

分派方式按**节点结构**判定，不给 `extractImportFromNode(node, sourceFile, resolveFn)` 增加 language 参数（该函数当前签名里没有语言信息，且 Scala 与 Kotlin 用的是同一个 `import` 节点类型）：`childForFieldName("path")` 存在 → 走 Scala 语义；缺失 → 走 Kotlin 语义（首 named child 为 `qualified_identifier`，路径最后一段为符号名；若存在第二个 `identifier`（`as` 别名）则符号名取别名）。路径最后一段为 `*` 时跳过该导入。

### 7. 文档更新

- `README.md`：③ 语言表新增 Kotlin 行（Chunking method 记 `tree-sitter`）；④ `indexExtensions` 示例（第 353 行附近）补 `.kt,.kts`；⑤ 依赖清单（第 860 行附近）新增 `@tree-sitter-grammars/tree-sitter-kotlin`；⑥ 表格下方「除 PHP 外均可 regex 回退」的枚举句需与 Kotlin 的实际策略对齐（Kotlin 与 TS/JS 一样无回退）。
- `README.zh.md`：同步语言表与依赖清单。
- `CLAUDE.md`（第 140 行附近的 Supported languages 表）：新增 Kotlin 行。

## 错误处理

- tree-sitter 加载或解析抛错 → `chunkCode` 落到 `chunkWithRegex`；Kotlin 无 regex 模式，`chunkWithRegex` 在 `if (!patterns) return []` 处返回空数组（与 TS/JS 现状一致），不抛错、不中断索引。
- 文件含 `ERROR` 节点 → 不影响入库，按可用节点切块（同其他语言）。
- `resolveImportPath` 返回的路径不存在 → import 边为 unresolved，不报错（复用现有逻辑）。

## 测试

测试落在**既有**测试文件里（不新建 spec 文件，与 C/Scala/PHP 的落点一致）：分块与命名用例加进 `packages/core/test/dsh-context-remdb.spec.ts` 的 chunking 区块，import 解析用例加进 `packages/core/test/import-resolver.spec.ts`。覆盖：

1. **基本分块**：`.kt` 文件里的 `function_declaration`、`class_declaration`、`object_declaration` 都成块，`language` 为 `kotlin`、`name` 分别为函数名/类名/对象名。
2. **interface / enum / data class**：均由 `class_declaration` 成块且名字正确。
3. **属性命名**：`val plain = 1`、`const val NAME = "a"`（带修饰符）、类体里的 `val member` 三者的 `name` 正确（回归 `extractVariableBindingName`），**不是** `anonymous_property_declaration`，也不是 `const`。
4. **属性过滤**：函数体内（`block`）的局部 `val` **不**成块；顶层与 `class_body` 的 `val`/`var` 成块。
5. **`.kts`**：`chunkCode('/tmp/build.gradle.kts', ...)` 走 Kotlin 解析，顶层 `plugins {}` / 顶层 `val` 可按设计成块，`language` 为 `kotlin`。
6. **引用提取**：`add(1, 2)` 收集到 `add`；`Greeter("a").greet()` 收集到 `greet`（由 `identifier` 节点覆盖，见「设计 5」实现期修正），且不把整条表达式文本当符号。
7. **扩展名注册**：`getSupportedExtensions()` 含 `.kt`/`.kts`；`DEFAULT_EXTENSIONS.kotlin` 为 `['.kt', '.kts']`。
8. **import 解析**（`import-resolver.spec.ts`）：`import com.example.Bar` 产生一条指向 `.../com/example/Bar.kt` 的边；`import com.example.Bar as B` 的符号名为 `B`。
9. **回归**：现有语言（TS/Python/Java/C/Scala/PHP）的分块与命名测试保持通过——尤其 `extractNodeName` 与 `deriveExportsFromChunks` 的插入点（`extractSymbolFromNode` 本次不改动，见「设计 5」实现期修正）。

测试遵循仓库惯例：core spec 直接 import 源码，不触碰 Milvus SDK。运行方式：`node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts packages/core/test/import-resolver.spec.ts`。

## 验收标准

1. `getSupportedExtensions()` 含 `.kt` 与 `.kts`；`DEFAULT_EXTENSIONS.kotlin` 为 `['.kt', '.kts']`。
2. 索引一个含 `.kt`/`.kts` 的目录后，chunks 的 `language` 为 `kotlin`，函数/类/对象 chunk 的 `name` 正确，且**没有**文件落入 `failedFiles`（这是「只改扩展名列表」方案会踩的坑）。
3. `const val` 属性名正确；函数体内的局部 `val` 不成块。
4. `import` 跨文件引用可被 import-resolver 解析为指向 `.kt` 目标。
5. `npm test` 全绿；`npm run typecheck` 通过。
6. 文档（README.md / README.zh.md / CLAUDE.md）语言表与依赖清单含 Kotlin。
