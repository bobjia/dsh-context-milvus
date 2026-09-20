# Kotlin Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Kotlin (`.kt` / `.kts`) indexing support to the `dsh-context-milvus-core` engine — tree-sitter AST chunking, correct `val`/`const val` name extraction, call-reference extraction, and cross-file `import` resolution.

**Architecture:** Add a `kotlin` entry to the chunker's `LANGUAGES` registry backed by `@tree-sitter-grammars/tree-sitter-kotlin`, register the two extensions in `DEFAULT_EXTENSIONS`, extend the shared name-extraction helper for Kotlin's `property_declaration` shape (used by both `chunker.ts` and `import-resolver.ts`), teach `extractSymbolFromNode` about Kotlin's field-less `call_expression`, and dispatch the `import` node structurally (Scala keeps its `path` field; Kotlin has none). DSH/Codex adapters need zero changes — they consume the core barrel.

**Tech Stack:** TypeScript (ESM / NodeNext / strict), tree-sitter 0.25.1 + `@tree-sitter-grammars/tree-sitter-kotlin` 1.1.0 (prebuilt native binaries, no compile step), jest under `--experimental-vm-modules`.

---

## Global Constraints

- **Only `packages/core` (plus docs and tests).** `packages/dsh` and `packages/codex` are untouched; the two existing language tables are `README.md` and `README.zh.md`, and `CLAUDE.md` has a third.
- **Language name is exactly `'kotlin'`**; extensions are exactly `['.kt', '.kts']`.
- **No regex fallback for Kotlin.** Do NOT add a `kotlin` key to `REGEX_PATTERNS` (line 583) and do NOT add a Kotlin branch to `regexChunkType` (line 669). Kotlin joins TypeScript/JavaScript in the "tree-sitter only" group: if the grammar cannot load, `chunkCode` falls through to `chunkWithRegex`, which returns `[]` at its `if (!patterns) return []` guard. The comment at line 580 enumerating regex-fallback languages therefore stays unchanged.
- **`property_declaration` MUST be gated by `chunkNodeFilter`** (file-level `source_file` and `class_body` only). `collectChunks` walks the whole tree to depth 10, so an ungated `property_declaration` would chunk every local `val` inside every function body.
- **Name extraction lives in exactly one shared helper.** `extractVariableBindingName` is exported from `chunker.ts` and called by BOTH `extractNodeName` (chunker) and `deriveExportsFromChunks` (import-resolver). Do not copy the logic.
- **Kotlin AST quirks (all verified against grammar 1.1.0) — do not "simplify" these away:**
  - `property_declaration` NEVER has a `name` field; the binding is `variable_declaration` → `identifier`, and a `modifiers` node may precede it (`const val NAME`).
  - `call_expression` has NO `function` field; the callee is the first named child.
  - `import` has NO `path` field; the first named child is a `qualified_identifier`.
  - `class_declaration` covers `class` / `data class` / `sealed class` / `enum class` / `interface` — there is no `interface_declaration` node type in this grammar.
  - A single-line class body (`class A { fun f() {} }`) produces an `ERROR` node; multi-line is clean. This is upstream grammar behavior and is NOT in scope.
- **Core boundary rules:** `packages/core/src` must not import `@deepseek-ai/*`, `@modelcontextprotocol/*`, or `zod`, and must not use `console.log/warn/info` outside `logger.ts`.
- **Installs need `--legacy-peer-deps`** (pre-existing peer conflict in this repo).
- **Tests run via:** `node --experimental-vm-modules node_modules/.bin/jest <path>`. Plain `npx jest` does NOT work here.
- Grammar dependency version: `^1.1.0`. Verified: loads under `tree-sitter@0.25.1`, prebuilds exist for `darwin/linux/win32` × `x64/arm64`.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `packages/core/package.json` | Declares the grammar dependency | Add `@tree-sitter-grammars/tree-sitter-kotlin` |
| `packages/core/src/config.ts` | Which files get walked | Add `kotlin: ['.kt', '.kts']` to `DEFAULT_EXTENSIONS` |
| `packages/core/src/chunker.ts` | How files get chunked | Kotlin `LANGUAGES` entry, header comment, `extractVariableBindingName`, `extractNodeName` branch, `extractSymbolFromNode` cases |
| `packages/core/src/import-resolver.ts` | Cross-file import/export edges | Call the shared binding helper; dispatch the `import` node structurally |
| `packages/core/test/dsh-context-remdb.spec.ts` | Chunking behavior | Kotlin chunking, naming, filter, reference tests |
| `packages/core/test/import-resolver.spec.ts` | Import resolution | Kotlin import test |
| `README.md`, `README.zh.md`, `CLAUDE.md` | User-facing docs | Language table, `indexExtensions` example, grammar list |

---

### Task 1: Declare the Kotlin grammar dependency

**Files:**
- Modify: `packages/core/package.json` (dependencies block)

**Interfaces:**
- Consumes: nothing.
- Produces: `require('@tree-sitter-grammars/tree-sitter-kotlin')` resolvable from `packages/core` — this is what Task 2's `loadTs` calls.

- [ ] **Step 1: Add the dependency**

In `packages/core/package.json`, inside `"dependencies"`, add the entry as the first `tree-sitter`-prefixed line (the scoped package sorts before `tree-sitter`):

```json
  "dependencies": {
    "@tree-sitter-grammars/tree-sitter-kotlin": "^1.1.0",
    "@zilliz/milvus2-sdk-node": "^3.0.4",
    "ignore": "^7.0.6",
    "js-yaml": "^5.4.1",
    "tree-sitter": "^0.25.1",
```

> Only `packages/core` gets this. `packages/dsh/package.json` also lists eight grammars, but that list is stale — it never received `tree-sitter-c` when C support landed, and DSH still resolves grammars through workspace hoisting / the core dependency. Do not touch it.

- [ ] **Step 2: Install and verify resolution**

Run (needs network access; in a sandboxed shell, escalate this command):

```bash
npm install --legacy-peer-deps
```

Then verify the package resolves and the native binding loads against the installed runtime:

```bash
npm ls @tree-sitter-grammars/tree-sitter-kotlin
node -e "const Parser=require('tree-sitter'); const K=require('@tree-sitter-grammars/tree-sitter-kotlin'); const p=new Parser(); p.setLanguage(K); const t=p.parse('fun main() {}'); console.log('kotlin grammar OK', t.rootNode.type)"
```

Expected: `npm ls` lists the package under `dsh-context-milvus-core`, and the one-liner prints `kotlin grammar OK source_file`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json package-lock.json pnpm-lock.yaml
git commit -m "feat(core): declare tree-sitter-kotlin as a direct dependency"
```

(If `pnpm-lock.yaml` was not modified by the install, omit it from the add. Check `git status` first.)

---

### Task 2: Register `.kt`/`.kts` and add the Kotlin language definition

**Files:**
- Modify: `packages/core/src/config.ts:108-120` (`DEFAULT_EXTENSIONS`)
- Modify: `packages/core/src/chunker.ts:1-12` (header comment), `:317-321` (insert the Kotlin entry after the `scala` entry, before the closing `]` of `LANGUAGES`)
- Test: `packages/core/test/dsh-context-remdb.spec.ts` (append inside the chunking `describe` block, next to the Scala test at line 1301)

**Interfaces:**
- Consumes: `@tree-sitter-grammars/tree-sitter-kotlin` from Task 1.
- Produces: `EXT_MAP` entries for `.kt` and `.kts` → language name `'kotlin'`; `getSupportedExtensions()` includes both; `chunkCode(filePath, content, '.kt' | '.kts')` returns chunks. Later tasks rely on `chunkCode` accepting both extensions.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/dsh-context-remdb.spec.ts`, immediately after the Scala test that ends near line 1325:

```ts
  it('extracts functions, classes, and objects from Kotlin code', async () => {
    const { chunkCode } = await import('../src/chunker.js')

    const code = `
package com.example

fun add(a: Int, b: Int): Int {
    return a + b
}

class Greeter(val name: String) {
    fun greet(): String {
        return "hi " + name
    }
}

object Registry {
    val count = 0
}

interface Shape {
    fun area(): Double
}
`
    const chunks = await chunkCode('/tmp/test.kt', code, '.kt')
    expect(chunks.length).toBeGreaterThanOrEqual(4)
    expect(chunks.every((c) => c.language === 'kotlin')).toBe(true)

    const fn = chunks.find((c) => c.name === 'add')
    expect(fn).toBeDefined()
    expect(fn!.chunkType).toBe('function_declaration')

    const cls = chunks.find((c) => c.name === 'Greeter')
    expect(cls).toBeDefined()
    expect(cls!.chunkType).toBe('class_declaration')

    const obj = chunks.find((c) => c.name === 'Registry')
    expect(obj).toBeDefined()
    expect(obj!.chunkType).toBe('object_declaration')

    const iface = chunks.find((c) => c.name === 'Shape')
    expect(iface).toBeDefined()
    expect(iface!.chunkType).toBe('class_declaration')
  })

  it('registers .kt and .kts as indexed extensions', async () => {
    const { getSupportedExtensions } = await import('../src/chunker.js')
    const { DEFAULT_EXTENSIONS } = await import('../src/config.js')

    expect(getSupportedExtensions()).toContain('.kt')
    expect(getSupportedExtensions()).toContain('.kts')
    expect(DEFAULT_EXTENSIONS.kotlin).toEqual(['.kt', '.kts'])
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "Kotlin"
```

Expected: FAIL. The chunking test rejects with `Unsupported file extension: .kt`, and the registration test fails on `DEFAULT_EXTENSIONS.kotlin` being `undefined`.

- [ ] **Step 3: Register the extensions in `config.ts`**

In `DEFAULT_EXTENSIONS` (line 108), add Kotlin after `scala` (line 119):

```ts
  scala: ['.scala'],
  kotlin: ['.kt', '.kts'],
}
```

- [ ] **Step 4: Add the Kotlin language definition in `chunker.ts`**

Insert this object into the `LANGUAGES` array **after** the `scala` entry (which ends at line ~320 with `loadTs: () => require('tree-sitter-scala'),`) and before the array's closing `]`:

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
      // Kotlin's `property_declaration` covers `val`/`var`/`const val` at ANY level.
      // Only file-level and class-body properties are real API surface; local
      // variables inside function bodies would otherwise flood the index.
      chunkNodeFilter: (node: any) =>
        node.type !== 'property_declaration' ||
        node.parent?.type === 'source_file' ||
        node.parent?.type === 'class_body',
      referenceNodeTypes: ['call_expression', 'navigation_expression', 'identifier', 'import'],
      importNodeTypes: ['import'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // import com.example.Foo → <two levels up>/com/example/Foo.kt
        // Same convention as the java/scala branches: the file is assumed to sit
        // two directories below the source root.
        if (!importPath) return null
        const srcDir = path.dirname(path.dirname(sourceFile))
        return path.resolve(srcDir, importPath.replace(/\./g, '/') + '.kt')
      },
    },
    loadTs: () => require('@tree-sitter-grammars/tree-sitter-kotlin'),
  },
```

Notes for the implementer:
- `class_declaration` deliberately covers `class`, `data class`, `sealed class`, `enum class`, and `interface` — this grammar emits no `interface_declaration`.
- `primary_constructor` is deliberately absent: `class Greeter(val name: String)` is already covered by the `class_declaration` chunk, so a separate entry would only duplicate content.
- `loadTs` is a synchronous `require` (the grammar's `main` is the CJS `bindings/node`), matching `tree-sitter-scala`. Do not use the `await import(...)` form that `tree-sitter-c-sharp` needs.

- [ ] **Step 5: Update the chunker header comment**

At `packages/core/src/chunker.ts:3-4`, extend the tree-sitter language list (Kotlin is a tree-sitter language with no regex fallback, so the PHP sentence on lines 6-7 stays as is):

```ts
 * Uses tree-sitter AST for TypeScript/JavaScript/Python/Java/Go/Rust/C/C++/C#/Scala/Kotlin
 * (which works with the installed version). For other languages (PHP),
 * uses a regex-based fallback that detects function/class/method boundaries.
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:

```bash
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "Kotlin"
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "registers .kt"
```

Expected: PASS for both. `add`, `Greeter`, `Registry`, and `Shape` all resolve by name — Kotlin's `function_declaration`, `class_declaration`, and `object_declaration` carry a usable `name` field, so no name-extraction work is needed yet.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/config.ts packages/core/src/chunker.ts packages/core/test/dsh-context-remdb.spec.ts
git commit -m "feat(core): register .kt/.kts and add the Kotlin tree-sitter language"
```

---

### Task 3: Extract names for Kotlin `property_declaration` (shared helper)

**Files:**
- Modify: `packages/core/src/chunker.ts:393-414` (add the exported helper after `extractDeclaratorName`), `:415-419` (`extractNodeName` branch)
- Modify: `packages/core/src/import-resolver.ts:12` (import the helper), `:263-275` (`deriveExportsFromChunks` branch)
- Test: `packages/core/test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: the `kotlin` language entry from Task 2.
- Produces: `export function extractVariableBindingName(node: any): string | null` in `chunker.ts`, consumed by `import-resolver.ts`. Later tasks do not depend on it, but the import-resolution task relies on exports being derived correctly.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/test/dsh-context-remdb.spec.ts`:

```ts
  it('names Kotlin properties, including const val and class members', async () => {
    const { chunkCode } = await import('../src/chunker.js')

    const code = `
const val NAME = "a"
val plain = 1

class Holder {
    var counter = 0
}

fun compute(): Int {
    val localOnly = 3
    return localOnly
}
`
    const chunks = await chunkCode('/tmp/test.kt', code, '.kt')
    const names = chunks.map((c) => c.name)

    // Modifiers (`const`) must not be mistaken for the binding name
    expect(names).toContain('NAME')
    expect(names).not.toContain('const')
    expect(names).toContain('plain')
    expect(names).toContain('counter')

    // Never fall back to the anonymous placeholder for properties
    expect(names).not.toContain('anonymous_property_declaration')

    // Local variables inside a function body are not chunked
    expect(names).not.toContain('localOnly')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "names Kotlin properties"
```

Expected: FAIL on `expect(names).toContain('NAME')` — `property_declaration` has no `name` field, so today every property is named `anonymous_property_declaration`.

- [ ] **Step 3: Add the shared helper to `chunker.ts`**

Insert directly after `extractDeclaratorName` (which ends at line 414, just before `function extractNodeName` at line 415):

```ts
/**
 * Kotlin: `property_declaration` has no `name` field — the binding lives in the
 * `variable_declaration` child's `identifier`. Modifiers add a `modifiers` node as
 * the first named child (`const val NAME = "a"`), so neither `childForFieldName('name')`
 * nor "first named child" yields the name.
 *
 * Returns the binding identifier text, or null for non-property nodes.
 * Shared by extractNodeName (chunker) and deriveExportsFromChunks (import-resolver).
 */
export function extractVariableBindingName(node: any): string | null {
  const varDecl = node.namedChildren?.find((c: any) => c.type === 'variable_declaration')
  if (!varDecl) return null
  const ident = varDecl.namedChildren?.find((c: any) => c.type === 'identifier')
  return ident ? ident.text : null
}
```

- [ ] **Step 4: Call it from `extractNodeName`**

In `extractNodeName` (line 415), insert the Kotlin branch after the `name` field check and **before** `extractDeclaratorName`:

```ts
function extractNodeName(node: any): string {
  const nameNode = node.childForFieldName('name')
  if (nameNode) return nameNode.text

  // Kotlin: property_declaration keeps its binding name in a variable_declaration child
  const bindingName = extractVariableBindingName(node)
  if (bindingName) return bindingName

  // C/C++: the name lives on the declarator field chain. Must be checked
  // BEFORE `type` — in C/C++ the `type` field is the return type
  // (`int add(...)` → type=int, declarator=function_declarator → identifier=add)
  const declaratorName = extractDeclaratorName(node)
  if (declaratorName) return declaratorName
```

The rest of the function is unchanged. Other languages are unaffected: no existing language emits a `variable_declaration` node, so the new call returns `null` for all of them.

- [ ] **Step 5: Call it from `deriveExportsFromChunks`**

First extend the import at `packages/core/src/import-resolver.ts:12`:

```ts
import { getParser, hasTsParser, getLanguageForExtension, extractDeclaratorName, extractVariableBindingName } from './chunker.js'
```

Then update `deriveExportsFromChunks` (line 255). The existing `else` branch becomes:

```ts
        if (nameNode) {
          symbols.push(nameNode.text)
        } else {
          // Kotlin: property_declaration holds its binding in a variable_declaration child
          const bindingName = extractVariableBindingName(node)
          if (bindingName) {
            symbols.push(bindingName)
          } else {
            // C/C++: name lives on the declarator field chain (shared helper)
            const declaratorName = extractDeclaratorName(node)
            if (declaratorName) {
              symbols.push(declaratorName)
            } else {
              const typeNode = node.childForFieldName('type')
              if (typeNode) {
                symbols.push(typeNode.text)
              } else {
                const identifierNode = node.childForFieldName('identifier')
                if (identifierNode) symbols.push(identifierNode.text)
              }
            }
          }
        }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run:

```bash
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts
```

Expected: PASS, including the pre-existing Scala/PHP/C/TypeScript chunking tests.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/chunker.ts packages/core/src/import-resolver.ts packages/core/test/dsh-context-remdb.spec.ts
git commit -m "feat(core): resolve Kotlin property binding names via shared helper"
```

---

### Task 4: Cover Kotlin call references (test only — no production change)

**Files:**
- Test: `packages/core/test/dsh-context-remdb.spec.ts`

**Interfaces:**
- Consumes: `chunkCode` with Kotlin support from Task 2.
- Produces: a regression guard over chunk `references` for Kotlin. No production code changes.

> **Implementation-time correction.** This task originally called for extending
> `extractSymbolFromNode` with a `call_expression` fallback and a new
> `navigation_expression` case. Executing the failing test proved that change
> unnecessary: Kotlin's call names are already collected through the `identifier`
> nodes listed in the Task 2 `referenceNodeTypes`, and the existing
> `call_expression` branch returns `null` for Kotlin (no `function` field), which
> is exactly the non-noisy behavior we want. Adding the branches would re-derive
> symbols that are already present while pushing a `?? node.namedChildren?.[0]`
> fallback into shared extraction logic used by every language.

- [ ] **Step 1: Write the test**

Append to `packages/core/test/dsh-context-remdb.spec.ts`:

```ts
  it('collects Kotlin call references without expression noise', async () => {
    const { chunkCode } = await import('../src/chunker.js')

    const code = `
fun main() {
    val x = add(1, 2)
    println(x)
    Greeter("a").greet()
    service.load()
}
`
    const chunks = await chunkCode('/tmp/test.kt', code, '.kt')
    const main = chunks.find((c) => c.name === 'main')
    expect(main).toBeDefined()

    const refs = main!.references ?? []
    expect(refs).toContain('add')
    expect(refs).toContain('println')
    expect(refs).toContain('Greeter')
    expect(refs).toContain('greet')
    expect(refs).toContain('load')

    // Kotlin has no `function` field on call_expression — the naive path would
    // emit the whole expression text as a "symbol".
    expect(refs.some((r) => r.includes('('))).toBe(false)
  })
```

- [ ] **Step 2: Run the test — it PASSES as written**

Run:

```bash
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "Kotlin call references"
```

Expected: PASS, because identifiers already supply the reference set. Record the evidence so the next reader does not "re-fix" this:

```bash
node -e "
const Parser=require('tree-sitter');const K=require('@tree-sitter-grammars/tree-sitter-kotlin');
const p=new Parser();p.setLanguage(K);
const src='fun main() {\n    val x = add(1, 2)\n    println(x)\n    Greeter(\"a\").greet()\n    service.load()\n}';
const t=p.parse(src);const fn=t.rootNode.children.find(c=>c.type==='function_declaration');
console.log('identifiers:', [...new Set(fn.descendantsOfType('identifier').map(n=>n.text))].join(', '));
console.log('call_expression has function field:', fn.descendantsOfType('call_expression').some(c=>c.childForFieldName('function')!==null));
"
```

Expected: `identifiers: main, x, add, println, Greeter, greet, service, load` and `call_expression has function field: false`.

A test that passes before any implementation is a signal to re-read the plan, not to write code that the test does not need. Keep the test as the guard.

- [ ] **Step 3: Commit**

```bash
git add packages/core/test/dsh-context-remdb.spec.ts
git commit -m "test(core): cover Kotlin call reference extraction"
```

### Task 5: Resolve Kotlin `import` statements

**Files:**
- Modify: `packages/core/src/import-resolver.ts:455-470` (the `case 'import'` branch)
- Test: `packages/core/test/import-resolver.spec.ts` (add after the C test at line 180, plus a `kotlinAvailable` probe alongside `cAvailable` at line 129)

**Interfaces:**
- Consumes: the Kotlin `resolveImportPath` from Task 2 and the export derivation from Task 3.
- Produces: `resolver.resolve(filePath, symbol)` entries for Kotlin imports. Consumed by `getImports`/`isImportedFrom` and, downstream, by cross-file reference resolution.

- [ ] **Step 1: Write the failing test**

Add the availability probe next to the `cAvailable` block (`packages/core/test/import-resolver.spec.ts:129-138`):

```ts
  let kotlinAvailable = false

  beforeAll(async () => {
    try {
      const { getParser } = await import('../src/chunker.js')
      const parser = await getParser('.kt')
      const tree = parser.parse('fun main() {}')
      kotlinAvailable = tree && tree.rootNode && tree.rootNode.type === 'source_file'
    } catch {
      kotlinAvailable = false
    }
  })
```

Then add the test after the C import test:

```ts
  test('extracts Kotlin imports and exports', async () => {
    if (!kotlinAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver('/tmp/test-map.json')
    await resolver.load()

    const content = `
      package com.example

      import com.example.Bar
      import com.example.util.*
      import com.example.Legacy as Old

      const val MAX = 10

      fun helper(): Int {
        return MAX
      }
    `
    await resolver.scanFile('/project/com/example/Usage.kt', content, '.kt')

    // Kotlin's `import` node has no `path` field — the qualified_identifier is the
    // first named child. Two levels up from the file is the source root.
    const barEntry = resolver.resolve('/project/com/example/Usage.kt', 'Bar')
    expect(barEntry).not.toBeNull()
    expect(barEntry!.target).toBe('/project/com/example/Bar.kt')
    expect(barEntry!.exportedAs).toBe('com.example.Bar')

    // `as` alias: the symbol is the alias, not the last path segment
    const aliasEntry = resolver.resolve('/project/com/example/Usage.kt', 'Old')
    expect(aliasEntry).not.toBeNull()
    expect(aliasEntry!.target).toBe('/project/com/example/Legacy.kt')

    // Star imports are skipped entirely — no symbol named `*`
    expect(resolver.resolve('/project/com/example/Usage.kt', '*')).toBeNull()

    // Exports are derived from chunks, including the property binding name
    const exports = resolver.getExports('/project/com/example/Usage.kt')
    expect(exports).toContain('helper')
    expect(exports).toContain('MAX')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/import-resolver.spec.ts -t "Kotlin imports"
```

Expected: FAIL on `expect(barEntry).not.toBeNull()` — the existing `case 'import'` reads `childForFieldName('path')`, which Kotlin's `import` node does not have, so no edges are produced.

- [ ] **Step 3: Implement the structural dispatch**

Replace the `case 'import'` body (`packages/core/src/import-resolver.ts:455-470`) with:

```ts
    case 'import': {
      // Two grammars share this node type and need different field access:
      //   Scala:  import com.example.Foo   → `path` field holds the qualified name
      //   Kotlin: import com.example.Foo   → no fields; first named child is a
      //           `qualified_identifier`, and `import a.B as C` adds an alias identifier
      const pathNode = node.childForFieldName('path') ?? node.namedChildren?.[0]
      if (!pathNode) return null
      const importPath = pathNode.text

      // Star imports (`import com.example.util.*`) expand to many symbols; skip them
      // rather than recording a symbol literally named `*`.
      if (importPath.endsWith('.*') || importPath.endsWith('*')) return null

      const targetFile = resolveFn?.(importPath, sourceFile) ?? null
      if (!targetFile) return null

      // Kotlin `as` alias: the alias identifier follows the path node
      const pathIndex = node.namedChildren.indexOf(pathNode)
      const aliasNode = node.namedChildren?.[pathIndex + 1]
      const symbol = aliasNode && aliasNode.type === 'identifier'
        ? aliasNode.text
        : importPath.split('.').pop()!

      results.push({
        symbol,
        entry: { target: targetFile, exportedAs: importPath },
      })
      break
    }
```

Note on `resolveFn(importPath, sourceFile)`: this returns the candidate path only. The import map stores it as the target and cross-file resolution decides later whether it matches a real file, so a wrong guess degrades to an unresolved edge rather than an error.

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
node --experimental-vm-modules node_modules/.bin/jest packages/core/test/import-resolver.spec.ts
```

Expected: PASS, including the pre-existing Scala/Java/Go/C#/C import tests.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/import-resolver.ts packages/core/test/import-resolver.spec.ts
git commit -m "feat(core): resolve Kotlin import statements and aliases"
```

---

### Task 6: Update the documentation

**Files:**
- Modify: `CLAUDE.md:140` (Supported languages table)
- Modify: `README.md:353` (`indexExtensions` example), `:621-622` (language table), `:624` (fallback note), `:860` (grammar list)
- Modify: `README.zh.md:360` (`indexExtensions` example), `:642` (language table), `:881` (grammar list)

**Interfaces:**
- Consumes: the extension and dependency names finalized in Tasks 1 and 2.
- Produces: nothing consumed by code.

- [ ] **Step 1: Update `CLAUDE.md`**

After the `Scala` row (line 140) in the supported-languages table:

```markdown
| Scala | .scala | tree-sitter |
| Kotlin | .kt, .kts | tree-sitter |
```

- [ ] **Step 2: Update `README.md`**

In the language table, insert a Kotlin row after the `Scala` row (line 621):

```markdown
| Kotlin | .kt, .kts | tree-sitter | function_declaration, class_declaration, object_declaration, companion_object, secondary_constructor, property_declaration, type_alias |
```

Then correct the fallback note below the table (line 624) — it currently claims every language but PHP has a regex fallback, which Kotlin also does not have:

```markdown
> All languages except PHP (regex-only), TypeScript/JavaScript, and Kotlin use tree-sitter AST parsing as the primary method. Python, Java, Go, Rust, C++, C#, and Scala automatically fall back to regex when tree-sitter parsing fails; **TypeScript / JavaScript / Kotlin have no regex fallback** — if tree-sitter parsing fails, the file is skipped (no index entry).
```

Add the grammar to the dependency list (after line 860):

```markdown
- `@tree-sitter-grammars/tree-sitter-kotlin` — Kotlin grammar
```

Finally, extend the `indexExtensions` example (line 353). Add `.kt,.kts` as the spec requires; while editing, note that this example was already missing `.c,.inc` from the C work — adding both keeps the sample truthful:

```bash
    indexExtensions: .ts,.tsx,.js,.py,.java,.go,.rs,.c,.inc,.cpp,.cs,.scala,.php,.kt,.kts
```

- [ ] **Step 3: Update `README.zh.md`**

Mirror the three edits in Chinese. Table row after line 642:

```markdown
| Kotlin | .kt, .kts | tree-sitter | function_declaration, class_declaration, object_declaration, companion_object, secondary_constructor, property_declaration, type_alias |
```

Grammar list (after line 881):

```markdown
- `@tree-sitter-grammars/tree-sitter-kotlin` — Kotlin 语法
```

And the `indexExtensions` example (line 360), matching the English edit:

```bash
    indexExtensions: .ts,.tsx,.js,.py,.java,.go,.rs,.c,.inc,.cpp,.cs,.scala,.php,.kt,.kts
```

If the Chinese table has a fallback note analogous to the English one at README.md:624, update it with the same Kotlin exclusion.

- [ ] **Step 4: Verify the docs mention Kotlin everywhere the language list appears**

Run:

```bash
grep -n "Kotlin" README.md README.zh.md CLAUDE.md
```

Expected: at least six matches (language row and grammar entry in each README, plus the CLAUDE.md row).

- [ ] **Step 5: Commit**

```bash
git add README.md README.zh.md CLAUDE.md
git commit -m "docs: document Kotlin support"
```

---

### Task 7: Full verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the full test suite**

Run:

```bash
npm test
```

Expected: all suites PASS (core, dsh, codex). If a Kotlin test is skipped, that means `kotlinAvailable`/the grammar probe failed — investigate rather than accepting a skip.

- [ ] **Step 2: Typecheck**

Run:

```bash
npm run typecheck
```

Expected: no type errors.

- [ ] **Step 3: Build**

Run:

```bash
npm run build
```

Expected: all three packages build cleanly.

- [ ] **Step 4: End-to-end sanity check — chunk a real `.kt`/`.kts` pair**

Drive the built core directly, mirroring what `index_code` does:

```bash
mkdir -p /tmp/kotlin-index-demo/com/example
cat > /tmp/kotlin-index-demo/com/example/Usage.kt <<'EOF'
package com.example

import com.example.Bar

const val MAX = 10

interface Shape {
    fun area(): Double
}

class Circle(val r: Double) : Shape {
    override fun area(): Double {
        return helper(r)
    }
}

object Registry {
    val count = 0
}

fun helper(x: Double): Double {
    val local = x * 2
    return local
}
EOF
cat > /tmp/kotlin-index-demo/build.gradle.kts <<'EOF'
val appVersion = "1.0.0"

fun banner(): String = "v" + appVersion
EOF
node --input-type=module -e "
import { chunkCode, getSupportedExtensions } from './packages/core/dist/chunker.js';
import { readFileSync } from 'node:fs';
console.log('supported:', ['.kt', '.kts'].every(e => getSupportedExtensions().includes(e)));
for (const f of ['/tmp/kotlin-index-demo/com/example/Usage.kt', '/tmp/kotlin-index-demo/build.gradle.kts']) {
  const ext = f.endsWith('.kts') ? '.kts' : '.kt';
  const chunks = await chunkCode(f, readFileSync(f, 'utf-8'), ext);
  console.log('---', f);
  for (const c of chunks) console.log(c.language, c.chunkType, c.name, JSON.stringify(c.references ?? []));
}
"
```

Expected output shape:

- `Usage.kt`: `kotlin function_declaration helper …`, `kotlin class_declaration Shape`, `kotlin class_declaration Circle … ["helper"]`, `kotlin object_declaration Registry`, and `kotlin property_declaration MAX`.
- `local` must NOT appear (function-body property filtered out).
- No chunk may be named `anonymous_property_declaration`, and none may be named `const`.
- `build.gradle.kts`: `kotlin property_declaration appVersion` and `kotlin function_declaration banner` — proof that `.kts` routes to the Kotlin grammar.

- [ ] **Step 5: Commit any stray changes**

```bash
git status
```

If clean, no commit needed. If unexpected changes exist, review and commit or revert them deliberately.

---

## Self-Review

**Spec coverage** (each spec section → task):

| Spec section | Task |
|---|---|
| 设计 1 — dependency | Task 1 |
| 设计 2 — extensions in `config.ts` | Task 2 Step 3 |
| 设计 3 — `LANGUAGES` entry + header comment | Task 2 Steps 4-5 |
| 设计 3 — `chunkNodeFilter` for properties | Task 2 Step 4 (code) + Task 3 Step 1 (behavioral test) |
| 设计 4 — shared binding-name helper | Task 3 |
| 设计 5 — reference extraction (corrected: no production change needed, identifiers already cover it) | Task 4 |
| 设计 6 — structural `import` dispatch + alias + star skip | Task 5 |
| 设计 7 — docs | Task 6 |
| 非目标 — no regex fallback | Global Constraints (explicit prohibition) |
| 错误处理 — grammar failure yields no chunks | Global Constraints + Task 7 Step 1 |
| 验收标准 1-6 | Tasks 2 (1), 7 (2), 3 (3), 5 (4), 7 Steps 1-2 (5), 6 (6) |

**Placeholder scan:** no `TBD`/`TODO`/"similar to Task N"/"add appropriate error handling" — every code step carries the full code, and every run step carries the exact command and the expected result.

**Type consistency:** `extractVariableBindingName` is defined once in Task 3 Step 3 and referenced with the same name and signature in Task 3 Steps 4-5. `chunkNodeFilter`, `chunkNodeTypes`, `referenceNodeTypes`, `importNodeTypes`, and `resolveImportPath` match the `LanguageConfig` interface in `packages/core/src/types.ts`. The Kotlin language string is `'kotlin'` in `config.ts`, `chunker.ts`, and every test assertion. Test expectations (`function_declaration`, `class_declaration`, `object_declaration`, `property_declaration`) match the grammar's real node type names as measured during design.
