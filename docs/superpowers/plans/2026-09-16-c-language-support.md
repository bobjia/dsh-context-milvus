# C Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add C language (`.c` extension) indexing support to the `dsh-context-milvus-core` engine — tree-sitter AST chunking with regex fallback, `#include` import resolution, and correct function/struct/typedef name extraction.

**Architecture:** Add a `c` entry to the chunker's `LANGUAGES` registry (tree-sitter-c grammar) plus a regex fallback, fix the shared name-extraction logic (two copies: `extractNodeName` in `chunker.ts` and `deriveExportsFromChunks` in `import-resolver.ts`) so C's `declarator → function_declarator → identifier` shape yields real symbol names, register `.c` in `DEFAULT_EXTENSIONS`, and document + test. The DSH and Codex adapters need zero changes — they consume the core barrel.

**Tech Stack:** TypeScript (ESM / NodeNext / strict), tree-sitter + tree-sitter-c (native grammar, already present in node_modules as a transitive dep), jest (`unstable_mockModule`), no new runtime deps beyond declaring `tree-sitter-c`.

## Global Constraints

- Only modify `packages/core` (plus docs + tests). Adapters (`packages/dsh`, `packages/codex`) are untouched.
- `.h` stays owned by C++ (`.c` and `.inc` are the new C extensions). Do NOT remove `.h` from the cpp extensions list.
- `.inc` is added to C per user decision. Note `.inc` is ambiguous in Linguist (C++, Assembly, BitBake, NASL) — accepted tradeoff.
- C's `declaration` chunk node type MUST be gated by `chunkNodeFilter` (only `function_declarator`-containing declarations = function prototypes). Never chunk plain variable declarations.
- The name-extraction change MUST check `declarator` BEFORE `type` (C's `type` field is the return type). Both `extractNodeName` (chunker.ts) and `deriveExportsFromChunks` (import-resolver.ts) must stay in sync, and both must apply `chunkNodeFilter`.
- Core boundary rules still apply: no `@deepseek-ai/*`, no `@modelcontextprotocol/*`, no zod imports; no `console.log` in `packages/core/src`.
- New dep `tree-sitter-c` pinned `^0.23.6` (dedupes with the already-installed 0.23.6; fresh installs resolve to 0.24.x which is ABI-compatible with tree-sitter 0.25.1).
- Language name string is exactly `'c'`; chunk types reuse existing type names (`function_definition`, `struct_specifier`, `enum_specifier`, `union_specifier`, `type_definition`, `declaration`).
- All tests run via the repo's jest setup: `node --experimental-vm-modules node_modules/.bin/jest <path>` (plain `npx jest` does NOT work here).
- `npm install` must use `--legacy-peer-deps` (pre-existing peer conflict).

---

### Task 1: Declare tree-sitter-c as a direct dependency

**Files:**
- Modify: `packages/core/package.json` (dependencies block, lines 15-28)

**Interfaces:**
- Consumes: nothing.
- Produces: `tree-sitter-c` resolvable via `require('tree-sitter-c')` from `packages/core` — this is what Task 2's `loadTs` uses.

- [ ] **Step 1: Add the dependency**

In `packages/core/package.json`, inside `"dependencies"`, add `"tree-sitter-c": "^0.23.6"` keeping alphabetical order (before `tree-sitter-c-sharp`):

```json
    "tree-sitter": "^0.25.1",
    "tree-sitter-c": "^0.23.6",
    "tree-sitter-c-sharp": "^0.23.5",
```

- [ ] **Step 2: Install and verify resolution**

Run: `npm install --legacy-peer-deps`

Then verify the package is a direct dependency of core and still resolvable:

```bash
npm ls tree-sitter-c
node -e "const C = require('tree-sitter-c'); console.log(typeof C === 'object' ? 'tree-sitter-c OK' : 'unexpected: ' + typeof C)"
```

Expected: `tree-sitter-c` appears under `dsh-context-milvus-core` in `npm ls`, and the node one-liner prints `tree-sitter-c OK`.

- [ ] **Step 3: Commit**

```bash
git add packages/core/package.json packages/core/package-lock.json
git commit -m "feat(core): declare tree-sitter-c as a direct dependency"
```

---

### Task 2: Add the C language definition to the chunker (+ chunkNodeFilter type)

**Files:**
- Modify: `packages/core/src/chunker.ts` — insert a new `LanguageDef` into the `LANGUAGES` array, after the `cpp` entry (which ends at line 240) and before the `csharp` entry (line 241)
- Modify: `packages/core/src/types.ts` — add optional `chunkNodeFilter` to `LanguageConfig` (line 73-81)

**Interfaces:**
- Consumes: `tree-sitter-c` (Task 1); existing `path` import already at top of file.
- Produces: `.c` and `.inc` recognized by `getLanguageForExtension`, `isSupportedExtension`, `extensionToLanguage`, `getSupportedExtensions`, `hasTsParser`, and `chunkCode` — all driven by `EXT_MAP` built from `LANGUAGES`. Also produces the `chunkNodeFilter?: (node: any) => boolean` field on `LanguageConfig` consumed by Task 3's `deriveExportsFromChunks` and by `chunkWithTreeSitter`.

- [ ] **Step 1: Add `chunkNodeFilter` to the `LanguageConfig` type**

In `packages/core/src/types.ts`, in the `LanguageConfig` interface (lines 73-81), add the optional field after `chunkNodeTypes`:

```ts
export interface LanguageConfig {
  name: string
  extensions: string[]
  chunkNodeTypes: string[]
  chunkNodeFilter?: (node: any) => boolean  // NEW: only chunk nodes passing this filter
  referenceNodeTypes?: string[]  // AST node types to collect as references
  importNodeTypes?: string[]    // NEW: AST node types for import statements
  exportNodeTypes?: string[]    // NEW: AST node types for export statements
  resolveImportPath?: (importPath: string, sourceFile: string) => string | null  // NEW
}
```

- [ ] **Step 2: Write the failing test (C chunking via tree-sitter)**

In `packages/core/test/dsh-context-remdb.spec.ts`, inside the `describe('chunkCode (tree-sitter)', ...)` block, add this test right after the C++ test (after line 1090):

```ts
  it('extracts functions, structs, enums, typedefs, and macros from C code', async () => {
    const { chunkCode } = await import('../src/chunker.js')

    const code = `
#include <stdio.h>

typedef struct {
    int x;
    int y;
} Point;

struct Config {
    char name[32];
    unsigned count;
};

enum Color { RED, GREEN, BLUE };

static int add(int a, int b) {
    return a + b;
}

#define SQUARE(x) ((x) * (x))

int main(void) {
    Point p = {1, 2};
    struct Config cfg;
    printf("sum=%d\\n", add(p.x, p.y));
    return 0;
}
`
    const chunks = await chunkCode('/tmp/test.c', code, '.c')
    expect(chunks.length).toBeGreaterThanOrEqual(5)

    const addFn = chunks.find((c) => c.name === 'add')
    expect(addFn).toBeDefined()
    expect(addFn!.chunkType).toBe('function_definition')
    expect(addFn!.language).toBe('c')

    const point = chunks.find((c) => c.name === 'Point')
    expect(point).toBeDefined()
    expect(point!.chunkType).toBe('type_definition')

    const config = chunks.find((c) => c.name === 'Config')
    expect(config).toBeDefined()
    expect(config!.chunkType).toBe('struct_specifier')

    const color = chunks.find((c) => c.name === 'Color')
    expect(color).toBeDefined()
    expect(color!.chunkType).toBe('enum_specifier')

    const square = chunks.find((c) => c.name === 'SQUARE')
    expect(square).toBeDefined()
    expect(square!.chunkType).toBe('preproc_function_def')
  })
```

Add a second test for `.inc` files and prototype declarations:

```ts
  it('chunks function prototypes in .inc header files but not plain declarations', async () => {
    const { chunkCode } = await import('../src/chunker.js')

    const inc = `
#ifndef MYUTIL_INC
#define MYUTIL_INC

int helper(void);
void init(int size);
int (*callback)(int);
extern int global_count;
static int counter;

typedef struct { int x; int y; } Point;

#endif
`
    const chunks = await chunkCode('/tmp/myutil.inc', inc, '.inc')
    expect(chunks.length).toBeGreaterThanOrEqual(4)

    const helper = chunks.find((c) => c.name === 'helper')
    expect(helper).toBeDefined()
    expect(helper!.chunkType).toBe('declaration')
    expect(helper!.language).toBe('c')

    const init = chunks.find((c) => c.name === 'init')
    expect(init).toBeDefined()
    expect(init!.chunkType).toBe('declaration')

    const callback = chunks.find((c) => c.name === 'callback')
    expect(callback).toBeDefined()
    expect(callback!.chunkType).toBe('declaration')

    // Plain variable declarations must NOT become chunks
    const globalCount = chunks.find((c) => c.name === 'global_count')
    expect(globalCount).toBeUndefined()
    const counter = chunks.find((c) => c.name === 'counter')
    expect(counter).toBeUndefined()
  })
```

Note: both tests will FAIL now — `chunkCode` throws "Unsupported file extension" for `.c`/`.inc`. The prototype test additionally requires the `chunkNodeFilter` (Step 3) and Task 3's name fix.

- [ ] **Step 3: Run tests to verify they fail**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "C code"`

Expected: FAIL with `Unsupported file extension: .c` (and `.inc`).

- [ ] **Step 4: Add the C language definition**

In `packages/core/src/chunker.ts`, in the `LANGUAGES` array, insert after the `cpp` entry's closing `},` (line 240) and before the `csharp` entry (line 241):

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
      // Only chunk declarations that are function prototypes (int helper(void);),
      // filter out plain variable declarations (extern int global_count;)
      chunkNodeFilter: (node: any) =>
        node.type !== 'declaration' ||
        node.descendantsOfType('function_declarator').length > 0,
      referenceNodeTypes: ['call_expression', 'field_expression', 'identifier'],
      importNodeTypes: ['preproc_include'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // #include "foo.h" → ./foo.h
        if (!importPath) return null
        const dir = path.dirname(sourceFile)
        return path.resolve(dir, importPath)
      },
    },
    loadTs: () => require('tree-sitter-c'),
  },
```

- [ ] **Step 5: Apply the chunkNodeFilter in chunkWithTreeSitter**

In `packages/core/src/chunker.ts`, in `chunkWithTreeSitter`, after `collectChunks` builds `nodes` and before `.filter((n: any) => { ... seen ... })`, apply the language filter. Locate this block (around line 471-485):

```ts
  const chunkTypes = new Set(def.config.chunkNodeTypes)
  const nodes = collectChunks(root, chunkTypes, 0, 10)
  const seen = new Set<number>()
```

Change the `nodes` line to:

```ts
  const chunkTypes = new Set(def.config.chunkNodeTypes)
  const nodes = collectChunks(root, chunkTypes, 0, 10)
    .filter((n: any) => (def.config.chunkNodeFilter ? def.config.chunkNodeFilter(n) : true))
  const seen = new Set<number>()
```

- [ ] **Step 6: Run tests to verify the intermediate state**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "C code"`

Expected: FAIL — but now on name assertions (e.g. `addFn` undefined because names come back as `int`; `Point` missing as `type_definition`). This confirms `.c`/`.inc` are chunkable and the filter works, but names are wrong until Task 3. Verify the failure is about names, not "Unsupported file extension".

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/types.ts packages/core/src/chunker.ts packages/core/test/dsh-context-remdb.spec.ts
git commit -m "feat(core): add C language definition with chunkNodeFilter"
```

---

### Task 3: Fix name extraction for C's AST shape (two copies)

**Files:**
- Modify: `packages/core/src/chunker.ts` — `extractNodeName` function (lines 352-366)
- Modify: `packages/core/src/import-resolver.ts` — name extraction inside `deriveExportsFromChunks` (lines 262-271)

**Interfaces:**
- Consumes: `chunkNodeFilter` from Task 2 (must be applied in `deriveExportsFromChunks` too, so exports match chunks).
- Produces: correct `name` on C chunks (`add`, not `int`; `Point` for `typedef struct {...} Point;`; `helper` for `int helper(void);`) and correct symbols in the export map for C files. Must NOT change names for existing languages (TS/JS/Python/C++/etc.).

- [ ] **Step 1: Run the failing test to confirm current broken behavior**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "C code"`

Expected: FAIL — `addFn` is `undefined` because `extractNodeName` returns `int` for `function_definition` nodes (its `type` field holds the return type), so no chunk is named `add`.

- [ ] **Step 2: Fix `extractNodeName` in chunker.ts**

Replace the body of `extractNodeName` (current lines 353-365) with the corrected logic. **Critical ordering: `declarator` must be checked BEFORE `type`** — in C, `function_definition`'s `type` field is the return type (`int add(...)` → type=`int`, declarator=`add`). The name lives on the `declarator` field chain:

```ts
function extractNodeName(node: any): string {
  const nameNode = node.childForFieldName('name')
  if (nameNode) return nameNode.text

  // C/C++: the name lives on the declarator field chain. Must be checked
  // BEFORE `type` — in C/C++ the `type` field is the return type
  // (`int add(...)` → type=int, declarator=function_declarator → identifier=add)
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
    // Last resort: first identifier-like descendant (covers pointer chains)
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

Note the field chain shapes this handles (verified against tree-sitter-c 0.23.6):
- `function_definition`: `declarator` field → `function_declarator` → its `declarator` field → `identifier` (`add`)
- `type_definition`: `declarator` field → `type_identifier` directly (`Point`)
- `declaration` (prototype): `declarator` field → `function_declarator` → `identifier` (`helper`)
- `int (*callback)(int)`: `declarator` → `pointer_declarator` → `function_declarator` → `identifier` (`callback`)

- [ ] **Step 3: Run the chunker test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "C code"`

Expected: PASS — `add` (function_definition), `Point` (type_definition), `Config` (struct_specifier), `Color` (enum_specifier), `SQUARE` (preproc_function_def) all found; `helper`/`init`/`callback` (declaration) found; `global_count`/`counter` NOT found.

- [ ] **Step 4: Fix the same logic in import-resolver.ts**

In `packages/core/src/import-resolver.ts`, inside `deriveExportsFromChunks` (lines 255-286), replace the name-extraction block and apply the `chunkNodeFilter` so C nodes export their real names and non-prototype declarations are excluded:

```ts
  private deriveExportsFromChunks(root: any, filePath: string, config: LanguageConfig): void {
    const chunkTypes = new Set(config.chunkNodeTypes)
    const symbols: string[] = []

    function walk(node: any): void {
      if (!node || !node.type) return

      if (chunkTypes.has(node.type) && (config.chunkNodeFilter ? config.chunkNodeFilter(node) : true)) {
        // Extract node name using the same logic as extractNodeName
        const nameNode = node.childForFieldName('name')
        if (nameNode) {
          symbols.push(nameNode.text)
        } else {
          // C/C++: name lives on the declarator field chain
          const declarator = node.childForFieldName('declarator')
          if (declarator) {
            let current: any = declarator
            let found = false
            while (current && !found) {
              const t = current.type
              if (t === 'identifier' || t === 'type_identifier' || t === 'field_identifier') {
                symbols.push(current.text)
                found = true
              }
              const next = current.childForFieldName('declarator')
              if (!next) break
              current = next
            }
            // Fallback: first identifier-like descendant (only if nothing pushed)
            if (!found) {
              const ids = declarator.descendantsOfType('identifier')
              const tids = declarator.descendantsOfType('type_identifier')
              const fallback = ids[0] ?? tids[0]
              if (fallback) symbols.push(fallback.text)
            }
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

      if (node.childCount > 0) {
        for (const child of node.children) {
          walk(child)
        }
      }
    }

    walk(root)
    // Deduplicate
    const unique = [...new Set(symbols)]
    if (unique.length > 0) {
      this.map.exports[filePath] = unique
    }
  }
```

Note: the `config.chunkNodeFilter` usage in this function keeps chunk-derived exports consistent with the chunks produced by `chunkWithTreeSitter` (Task 2 Step 5). The `found` flag ensures the fallback only runs when the field-chain walk found nothing, and the final `new Set` dedupes anyway.

- [ ] **Step 5: Add the C import-resolution test**

In `packages/core/test/import-resolver.spec.ts`, inside the `describe('ImportResolver scanFile', ...)` block, add a C test. Add a `cAvailable` guard next to the existing `tsAvailable` (line 118):

```ts
  let cAvailable = false

  beforeAll(async () => {
    try {
      const { getParser } = await import('../src/chunker.js')
      const parser = await getParser('.c')
      const tree = parser.parse('int main(void) { return 0; }')
      cAvailable = tree && tree.rootNode && tree.rootNode.type === 'translation_unit'
    } catch {
      cAvailable = false
    }
  })
```

Then the test (after the TypeScript test at line 153):

```ts
  test('extracts C #include imports and exports', async () => {
    if (!cAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver('/tmp/test-map.json')
    await resolver.load()

    const content = `
      #include "myutil.h"
      #include <stdio.h>
      int helper(void);
      int main(void) { return helper(); }
    `
    await resolver.scanFile('/project/src/main.c', content, '.c')

    // #include "myutil.h" → target ./myutil.h, symbol myutil
    const myutilEntry = resolver.resolve('/project/src/main.c', 'myutil')
    expect(myutilEntry).not.toBeNull()
    expect(myutilEntry!.target).toBe('/project/src/myutil.h')
    expect(myutilEntry!.exportedAs).toBe('myutil')

    // main and helper should be exported as chunk symbols
    const exports = resolver.getExports('/project/src/main.c')
    expect(exports).toContain('main')
    expect(exports).toContain('helper')
  })
```

Note: the `cAvailable` guard uses `translation_unit` (the C root node type). Since `getParser` caches per-extension, this also covers `.inc` (same grammar).

- [ ] **Step 6: Run all core tests to check for regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts packages/core/test/import-resolver.spec.ts`

Expected: PASS — all chunker tests (all languages) and import-resolver tests pass. This confirms the `extractNodeName` change didn't break existing languages.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/chunker.ts packages/core/src/import-resolver.ts packages/core/test/dsh-context-remdb.spec.ts packages/core/test/import-resolver.spec.ts
git commit -m "fix(core): extract C names from declarator field chain in chunker and import resolver"
```

---

### Task 4: Register `.c` in default extensions + regex fallback

**Files:**
- Modify: `packages/core/src/config.ts` — `DEFAULT_EXTENSIONS` (lines 108-119)
- Modify: `packages/core/src/chunker.ts` — `REGEX_PATTERNS` (add `c` after the `cpp` entry, line 571) and `regexChunkType` (add `c` branch after the `cpp` branch, line 627)

**Interfaces:**
- Consumes: `DEFAULT_EXTENSIONS` from config (used by indexer for extension filtering); `REGEX_PATTERNS` / `regexChunkType` used by `chunkWithRegex` (fallback when tree-sitter fails).
- Produces: `.c` files indexed by the default indexer; a regex fallback for C (consistency with C++/Python/etc., even though tree-sitter-c normally succeeds).

- [ ] **Step 1: Add `.c` to DEFAULT_EXTENSIONS**

In `packages/core/src/config.ts`, in `DEFAULT_EXTENSIONS`, add the `c` key (before `cpp` for logical grouping):

```ts
export const DEFAULT_EXTENSIONS: Record<string, string[]> = {
  typescript: ['.ts', '.tsx', '.mts', '.cts'],
  javascript: ['.js', '.jsx', '.mjs', '.cjs'],
  python: ['.py'],
  rust: ['.rs'],
  go: ['.go'],
  java: ['.java'],
  php: ['.php'],
  c: ['.c', '.inc'],
  cpp: ['.cpp', '.cxx', '.cc', '.hpp', '.h', '.hh'],
  csharp: ['.cs'],
  scala: ['.scala'],
}
```

- [ ] **Step 2: Add C regex patterns**

In `packages/core/src/chunker.ts`, in `REGEX_PATTERNS`, add a `c` key after the `cpp` entry:

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

- [ ] **Step 3: Add the `c` branch to regexChunkType**

In `packages/core/src/chunker.ts`, in `regexChunkType`, add a `c` branch after the `cpp` branch:

```ts
  if (language === 'c') {
    if (/^struct\s/.test(line)) return 'struct_specifier'
    if (/^union\s/.test(line)) return 'union_specifier'
    if (/^enum\s/.test(line)) return 'enum_specifier'
    if (/^typedef\s/.test(line)) return 'type_definition'
    return 'function_definition'
  }
```

- [ ] **Step 4: Verify regex fallback works (manual verification)**

The regex path is only exercised when tree-sitter fails, so it can't be reached through `chunkCode` for `.c` (tree-sitter-c works). Verify the patterns match C constructs with a throwaway script:

```bash
node -e "
const patterns = [
  /^(?:(?:static|inline|extern|const|volatile|register)\s+)*(?:unsigned|signed|long|short|char|int|float|double|void|struct|union|enum|size_t|ssize_t|int8_t|uint8_t|int16_t|uint16_t|int32_t|uint32_t|int64_t|uint64_t|const\s+\w+|\w+)\s+(?:[*&]\s*)?(\w+)\s*\(/gm,
  /^struct\s+(\w+)/gm,
  /^union\s+(\w+)/gm,
  /^enum\s+(\w+)/gm,
  /^typedef\s+.*\b(\w+)\s*;$/gm,
];
const code = \`static int add(int a, int b) { return a+b; }
struct Config { char name[32]; };
union U { int i; float f; };
enum Color { RED, GREEN, BLUE };
typedef struct { int x; } Point;\`;
for (const p of patterns) { p.lastIndex = 0; const m = p.exec(code); if (m) console.log(m[1] ?? '(no group)'); }
"
```

Expected output contains: `add`, `Config`, `U`, `Color`, `Point` (in that order, one per pattern).

- [ ] **Step 5: Run core tests and commit**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts packages/core/test/config.spec.ts`

Expected: PASS.

```bash
git add packages/core/src/config.ts packages/core/src/chunker.ts
git commit -m "feat(core): register .c extension and add C regex fallback"
```

---

### Task 5: Update documentation

**Files:**
- Modify: `CLAUDE.md` — "Supported languages" table (lines 127-140)
- Modify: `README.md` — "Code Chunking" table (lines 557-570) and the dependency list (around line 798)
- Modify: `README.zh.md` — "Code Chunking" table (lines 566-577) and the dependency list (around line 805)

**Interfaces:**
- Consumes: the exact language name `c`, extensions `.c`/`.inc`, and chunk node types from Task 2.
- Produces: accurate user-facing docs.

- [ ] **Step 1: Update CLAUDE.md**

In the "Supported languages" table, add a C row before the C++ row:

```markdown
| C | .c, .inc | tree-sitter |
```

- [ ] **Step 2: Update README.md**

In the "Code Chunking" table, add a C row before C++ (line 565):

```markdown
| C | .c, .inc | tree-sitter + regex fallback | function_definition, struct_specifier, enum_specifier, union_specifier, type_definition, preproc_function_def, declaration (prototypes only) |
```

In the dependency list (around line 798, the `tree-sitter-*` entries), add:

```markdown
- `tree-sitter-c` — C grammar
```

- [ ] **Step 3: Update README.zh.md**

In the "Code Chunking" table, add the same C row (before C++ at line 566), and add `tree-sitter-c` to the dependency list (around line 805). Match the existing zh wording style (e.g. `tree-sitter + regex 回退`).

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md README.zh.md
git commit -m "docs: document C language support"
```

---

### Task 6: Full verification

**Files:**
- None (verification only).

**Interfaces:**
- Consumes: all prior tasks.

- [ ] **Step 1: Run the full core test suite**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/`

Expected: all core tests PASS.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`

Expected: no type errors (builds core first; dsh/codex resolve it via emitted dist/*.d.ts).

- [ ] **Step 3: Build**

Run: `npm run build`

Expected: all three packages build cleanly.

- [ ] **Step 4: End-to-end sanity check — index a C file and confirm language + name**

Create a throwaway directory with a small C file, then drive the core engine directly (mirrors what the DSH `index_code` does):

```bash
mkdir -p /tmp/c-index-demo
cat > /tmp/c-index-demo/main.c <<'EOF'
#include "util.h"
int add(int a, int b) { return a + b; }
struct Point { int x; int y; };
int main(void) { struct Point p = {1, 2}; return add(p.x, p.y); }
EOF
cat > /tmp/c-index-demo/util.h <<'EOF'
int helper(void);
EOF
cat > /tmp/c-index-demo/config.inc <<'EOF'
#define MAX_BUF 128
int init_buffer(void);
extern int debug_level;
EOF
node --input-type=module -e "
import { chunkCode } from './packages/core/dist/chunker.js';
import { readFileSync } from 'node:fs';
for (const f of ['/tmp/c-index-demo/main.c', '/tmp/c-index-demo/config.inc']) {
  const content = readFileSync(f, 'utf-8');
  const chunks = await chunkCode(f, content, f.endsWith('.inc') ? '.inc' : '.c');
  console.log('---', f);
  for (const c of chunks) console.log(c.language, c.chunkType, c.name);
}
"
```

Expected: for `main.c` each chunk prints `c <chunkType> <name>` with `add`, `Point`, `main` present and no `int`-as-name. For `config.inc`: `c preproc_function_def MAX_BUF`? No — `#define MAX_BUF 128` is a `preproc_def` (object-like macro), which is NOT in chunkNodeTypes, so it won't chunk (correct — only function-like macros `#define F(x)` chunk). Expected `.inc` output: `c preproc_function_def init_buffer` is wrong too — `int init_buffer(void);` is a prototype `declaration`, so expect `c declaration init_buffer`; `extern int debug_level;` must NOT appear (filtered). Verify `main`, `add`, `Point` for `.c` and `init_buffer` (declaration) for `.inc`, with `debug_level` absent.

- [ ] **Step 5: Commit any stray changes**

```bash
git status
```

If clean, no commit needed. If unexpected changes exist, review and commit or revert them deliberately.

---

## Self-Review

**1. Spec coverage:**
- Dependency declaration (spec §1) → Task 1 ✓
- `chunkNodeFilter` type addition (spec §2b) → Task 2 Step 1 ✓
- Language definition with `.c`/`.inc`, chunkNodeTypes incl. filtered `declaration`, referenceNodeTypes, importNodeTypes, resolveImportPath (spec §2) → Task 2 ✓
- Filter application in chunkWithTreeSitter (spec §2b) → Task 2 Step 5 ✓
- `extractNodeName` + `deriveExportsFromChunks` declarator-chain fix, declarator-before-type (spec §3) → Task 3 ✓
- Filter application in deriveExportsFromChunks (spec §2b) → Task 3 Step 4 ✓
- Regex fallback + regexChunkType (spec §4) → Task 4 ✓
- DEFAULT_EXTENSIONS `.c`/`.inc` (spec §5) → Task 4 ✓
- Docs CLAUDE.md/README/README.zh (spec §6) → Task 5 ✓
- Error handling (spec) → covered implicitly: tree-sitter failure falls to regex (Task 4), no-regex-match returns [] (existing behavior), include resolution failure returns null (existing preproc_include path) ✓
- Tests: tree-sitter path, name correctness, typedef, macro, `.inc` + prototype filtering, import resolution (spec §Test) → Tasks 2-3 ✓; regex fallback → Task 4 manual verification (matches repo convention: regex paths for tree-sitter-capable languages are not unit-tested; only PHP's pure-regex path is) ✓

**2. Placeholder scan:** No TBD/TODO. Every code step has concrete code. The `resolveImportPath` is fully specified. The regex `typedef` pattern is best-effort but concrete (verified: captures `Point` not `x`).

**3. Type consistency:** Language name `'c'` used consistently in chunker def, REGEX_PATTERNS key, regexChunkType branch, DEFAULT_EXTENSIONS key, and tests. Chunk type names (`function_definition`, `struct_specifier`, `enum_specifier`, `union_specifier`, `type_definition`, `preproc_function_def`, `declaration`) match the spec exactly. `chunkNodeFilter?: (node: any) => boolean` used identically in types.ts, chunker.ts (chunkWithTreeSitter), and import-resolver.ts (deriveExportsFromChunks). `resolveImportPath` signature `(importPath: string, sourceFile: string) => string | null` matches `LanguageConfig`. The import-resolver test uses `/project/src/myutil.h` target, consistent with `path.resolve('/project/src', 'myutil.h')`.

**Verified against real tree-sitter-c (not just assumed):**
- `function_definition` fields are `[type, declarator, body]` — the `type` field is the RETURN TYPE, confirming declarator-before-type ordering is required.
- `function_declarator`'s `declarator` field IS the identifier directly (no further nesting) — the while-loop over the declarator chain handles this correctly.
- `type_definition`'s `declarator` field is `type_identifier` directly.
- `int (*callback)(int)` resolves through `pointer_declarator` → `function_declarator` → `identifier`.
- `descendantsOfType('function_declarator')` correctly distinguishes prototypes from plain declarations (`extern int global_count;` has none).

**Deliberate deviations from the spec:** none — the spec was updated to match these verified findings (`.inc` extension, chunkNodeFilter, corrected name logic).
