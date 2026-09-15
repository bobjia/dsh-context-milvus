# C Language Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add C language (`.c` extension) indexing support to the `dsh-context-milvus-core` engine — tree-sitter AST chunking with regex fallback, `#include` import resolution, and correct function/struct/typedef name extraction.

**Architecture:** Add a `c` entry to the chunker's `LANGUAGES` registry (tree-sitter-c grammar) plus a regex fallback, fix the shared name-extraction logic (two copies: `extractNodeName` in `chunker.ts` and `deriveExportsFromChunks` in `import-resolver.ts`) so C's `declarator → function_declarator → identifier` shape yields real symbol names, register `.c` in `DEFAULT_EXTENSIONS`, and document + test. The DSH and Codex adapters need zero changes — they consume the core barrel.

**Tech Stack:** TypeScript (ESM / NodeNext / strict), tree-sitter + tree-sitter-c (native grammar, already present in node_modules as a transitive dep), jest (`unstable_mockModule`), no new runtime deps beyond declaring `tree-sitter-c`.

## Global Constraints

- Only modify `packages/core` (plus docs + tests). Adapters (`packages/dsh`, `packages/codex`) are untouched.
- `.h` stays owned by C++ (`.c` is the only new extension). Do NOT remove `.h` from the cpp extensions list.
- Core boundary rules still apply: no `@deepseek-ai/*`, no `@modelcontextprotocol/*`, no zod imports; no `console.log` in `packages/core/src`.
- New dep `tree-sitter-c` pinned `^0.23.6` (dedupes with the already-installed 0.23.6; fresh installs resolve to 0.24.x which is ABI-compatible with tree-sitter 0.25.1).
- Do not add `declaration` to C's `chunkNodeTypes` (would chunk every variable declaration).
- Language name string is exactly `'c'`; chunk types reuse existing type names (`function_definition`, `struct_specifier`, `enum_specifier`, `union_specifier`, `type_definition`).
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

### Task 2: Add the C language definition to the chunker

**Files:**
- Modify: `packages/core/src/chunker.ts` — insert a new `LanguageDef` into the `LANGUAGES` array, after the `cpp` entry (which ends at line 240) and before the `csharp` entry (line 241)

**Interfaces:**
- Consumes: `tree-sitter-c` (Task 1); existing `path` import already at top of file.
- Produces: `.c` recognized by `getLanguageForExtension`, `isSupportedExtension`, `extensionToLanguage`, `getSupportedExtensions`, `hasTsParser`, and `chunkCode` — all driven by `EXT_MAP` built from `LANGUAGES`.

- [ ] **Step 1: Write the failing test (C chunking via tree-sitter)**

In `packages/core/test/dsh-context-remdb.spec.ts`, inside the `describe('chunkCode (tree-sitter)', ...)` block, add this test right after the C++ test (after line 1090):

```ts
  it('extracts functions, structs, enums, and typedefs from C code', async () => {
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
    expect(chunks.length).toBeGreaterThanOrEqual(4)

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

Note: this test will FAIL at the `name === 'add'` assertion until Task 3 fixes `extractNodeName` — but it also fails outright now because `.c` is unsupported (`chunkCode` throws "Unsupported file extension"). Both failures are expected; the test is written once and stays.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "extracts functions, structs, enums, and typedefs from C code"`

Expected: FAIL with `Unsupported file extension: .c` (thrown from `chunkCode`).

- [ ] **Step 3: Add the C language definition**

In `packages/core/src/chunker.ts`, in the `LANGUAGES` array, insert after the `cpp` entry's closing `},` (line 240) and before the `csharp` entry (line 241):

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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "extracts functions, structs, enums, and typedefs from C code"`

Expected: FAIL — but now it fails on the name assertions (`add` not found; `Point` not found as `type_definition` because the anonymous struct's chunk has name `anonymous_struct_specifier` and the typedef name isn't extracted). This is the expected intermediate state: `.c` is now chunkable, but names are wrong until Task 3. Verify the failure is about names, not "Unsupported file extension".

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/chunker.ts packages/core/test/dsh-context-remdb.spec.ts
git commit -m "feat(core): add C language definition to chunker"
```

---

### Task 3: Fix name extraction for C's AST shape (two copies)

**Files:**
- Modify: `packages/core/src/chunker.ts` — `extractNodeName` function (lines 352-366)
- Modify: `packages/core/src/import-resolver.ts` — name extraction inside `deriveExportsFromChunks` (lines 262-271)

**Interfaces:**
- Consumes: nothing new.
- Produces: correct `name` on C chunks (`add`, not `int`; `Point` for `typedef struct {...} Point;`) and correct symbols in the export map for C files. Must NOT change names for existing languages (TS/JS/Python/C++/etc.).

- [ ] **Step 1: Run the failing test to confirm current broken behavior**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "extracts functions, structs, enums, and typedefs from C code"`

Expected: FAIL — `addFn` is `undefined` because `extractNodeName` returns `int` for `function_definition` nodes (its `type` field holds the return type), so no chunk is named `add`.

- [ ] **Step 2: Fix `extractNodeName` in chunker.ts**

Replace the body of `extractNodeName` (current lines 353-365) so that after the existing field checks it falls back to the `declarator` field, which is where C keeps the name:

```ts
function extractNodeName(node: any): string {
  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('type') ??
    node.childForFieldName('identifier')
  if (nameNode) return nameNode.text

  // C/C++: function_definition / type_definition keep the name inside a
  // declarator (function_declarator → declarator → identifier).
  // Example: `int add(int a, int b)` → declarator → function_declarator → add
  //          `typedef struct {...} Point;` → declarator → Point
  const declarator = node.childForFieldName('declarator')
  if (declarator) {
    const inner = declarator.childForFieldName('declarator') ?? declarator
    const innerName =
      inner.childForFieldName('name') ??
      inner.childForFieldName('identifier') ??
      inner.namedChildren.find(
        (c: any) => c.type === 'identifier' || c.type === 'type_identifier',
      )
    if (innerName) return innerName.text
  }

  for (const child of node.namedChildren) {
    const t = child.type
    if (t === 'identifier' || t === 'type_identifier' || t === 'property_identifier') {
      return child.text
    }
  }
  return `anonymous_${node.type}`
}
```

- [ ] **Step 3: Run the chunker test to verify it passes**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts -t "extracts functions, structs, enums, and typedefs from C code"`

Expected: PASS — `add` (function_definition), `Point` (type_definition), `Config` (struct_specifier), `Color` (enum_specifier), `SQUARE` (preproc_function_def) all found.

- [ ] **Step 4: Fix the same logic in import-resolver.ts**

In `packages/core/src/import-resolver.ts`, inside `deriveExportsFromChunks` (lines 262-271), replace the name-extraction block so C nodes export their real names:

```ts
      if (chunkTypes.has(node.type)) {
        // Extract node name using the same logic as extractNodeName
        const nameNode =
          node.childForFieldName('name') ??
          node.childForFieldName('type') ??
          node.childForFieldName('identifier')
        if (nameNode) {
          symbols.push(nameNode.text)
          continue
        }
        // C/C++: name lives in the declarator (function_declarator → identifier)
        const declarator = node.childForFieldName('declarator')
        if (declarator) {
          const inner = declarator.childForFieldName('declarator') ?? declarator
          const innerName =
            inner.childForFieldName('name') ??
            inner.childForFieldName('identifier') ??
            inner.namedChildren.find(
              (c: any) => c.type === 'identifier' || c.type === 'type_identifier',
            )
          if (innerName) symbols.push(innerName.text)
        }
      }
```

Note: the `continue` keyword works here because this code is inside a `function walk(node: any): void { ... }` with the `if` inside a `for` loop iteration — verify the structure when editing: the walk function's `if (chunkTypes.has(node.type))` block sits before the recursive `if (node.childCount > 0)` block, so `continue` skips the recursion for the current node (matching original behavior where a matched name node also skipped nothing extra — the original code did not `continue`, so be careful: the original just pushed and fell through to recursion). To keep behavior identical for existing languages, do NOT add `continue`; structure the fix as:

```ts
      if (chunkTypes.has(node.type)) {
        const nameNode =
          node.childForFieldName('name') ??
          node.childForFieldName('type') ??
          node.childForFieldName('identifier')
        if (nameNode) {
          symbols.push(nameNode.text)
        } else {
          const declarator = node.childForFieldName('declarator')
          if (declarator) {
            const inner = declarator.childForFieldName('declarator') ?? declarator
            const innerName =
              inner.childForFieldName('name') ??
              inner.childForFieldName('identifier') ??
              inner.namedChildren.find(
                (c: any) => c.type === 'identifier' || c.type === 'type_identifier',
              )
            if (innerName) symbols.push(innerName.text)
          }
        }
      }
```

- [ ] **Step 5: Add the C import-resolution test**

In `packages/core/test/import-resolver.spec.ts`, inside the `describe('ImportResolver scanFile', ...)` block (after the TypeScript test at line 153), add a C test that mirrors the TS one. It needs the same `tsAvailable`-style guard but for C (tree-sitter-c):

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

  test('extracts C #include imports', async () => {
    if (!cAvailable) return
    const { ImportResolver } = await import('../src/import-resolver.js')
    const resolver = new ImportResolver('/tmp/test-map.json')
    await resolver.load()

    const content = `
      #include "myutil.h"
      #include <stdio.h>
      int main(void) { return helper(); }
    `
    await resolver.scanFile('/project/src/main.c', content, '.c')

    // #include "myutil.h" → target ./myutil.h, symbol myutil
    const myutilEntry = resolver.resolve('/project/src/main.c', 'myutil')
    expect(myutilEntry).not.toBeNull()
    expect(myutilEntry!.target).toBe('/project/src/myutil.h')
    expect(myutilEntry!.exportedAs).toBe('myutil')

    // main should be exported as a chunk symbol
    const exports = resolver.getExports('/project/src/main.c')
    expect(exports).toContain('main')
  })
```

Note: `cAvailable` must be declared in the same describe scope as the test — place the `let cAvailable = false` declaration next to the existing `let tsAvailable = false` (line 118) and add a second `beforeAll` (or extend the existing one). The C root node type is `translation_unit`.

- [ ] **Step 6: Run all core tests to check for regressions**

Run: `node --experimental-vm-modules node_modules/.bin/jest packages/core/test/dsh-context-remdb.spec.ts packages/core/test/import-resolver.spec.ts`

Expected: PASS — all chunker tests (all languages) and import-resolver tests pass. This confirms the `extractNodeName` change didn't break existing languages.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/chunker.ts packages/core/src/import-resolver.ts packages/core/test/dsh-context-remdb.spec.ts packages/core/test/import-resolver.spec.ts
git commit -m "fix(core): extract C names from declarator field in chunker and import resolver"
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
  c: ['.c'],
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
- Consumes: the exact language name `c`, extensions `.c`, and chunk node types from Task 2.
- Produces: accurate user-facing docs.

- [ ] **Step 1: Update CLAUDE.md**

In the "Supported languages" table, add a C row before the C++ row:

```markdown
| C | .c | tree-sitter |
```

- [ ] **Step 2: Update README.md**

In the "Code Chunking" table, add a C row before C++ (line 565):

```markdown
| C | .c | tree-sitter + regex fallback | function_definition, struct_specifier, enum_specifier, union_specifier, type_definition, preproc_function_def |
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
node --input-type=module -e "
import { chunkCode } from './packages/core/dist/chunker.js';
import { readFileSync } from 'node:fs';
const content = readFileSync('/tmp/c-index-demo/main.c', 'utf-8');
const chunks = await chunkCode('/tmp/c-index-demo/main.c', content, '.c');
for (const c of chunks) console.log(c.language, c.chunkType, c.name);
"
```

Expected: each chunk prints `c <chunkType> <name>` with `add`, `Point`, `main` present and no `int`-as-name.

- [ ] **Step 5: Commit any stray changes**

```bash
git status
```

If clean, no commit needed. If unexpected changes exist, review and commit or revert them deliberately.

---

## Self-Review

**1. Spec coverage:**
- Dependency declaration (spec §1) → Task 1 ✓
- Language definition with chunkNodeTypes/referenceNodeTypes/importNodeTypes/resolveImportPath (spec §2) → Task 2 ✓
- `extractNodeName` + `deriveExportsFromChunks` declarator fix (spec §3) → Task 3 ✓
- Regex fallback + regexChunkType (spec §4) → Task 4 ✓
- DEFAULT_EXTENSIONS (spec §5) → Task 4 ✓
- Docs CLAUDE.md/README/README.zh (spec §6) → Task 5 ✓
- Error handling (spec) → covered implicitly: tree-sitter failure falls to regex (Task 4), no-regex-match returns [] (existing behavior), include resolution failure returns null (existing preproc_include path) ✓
- Tests: tree-sitter path, name correctness, typedef, macro, import resolution (spec §Test) → Tasks 2-3 ✓; regex fallback → Task 4 manual verification (matches repo convention: regex paths for tree-sitter-capable languages are not unit-tested; only PHP's pure-regex path is) ✓

**2. Placeholder scan:** No TBD/TODO. Every code step has concrete code. The `resolveImportPath` is fully specified. The regex `typedef` pattern is best-effort but concrete.

**3. Type consistency:** Language name `'c'` used consistently in chunker def, REGEX_PATTERNS key, regexChunkType branch, DEFAULT_EXTENSIONS key, and tests. Chunk type names (`function_definition`, `struct_specifier`, `enum_specifier`, `union_specifier`, `type_definition`, `preproc_function_def`) match the spec exactly. `resolveImportPath` signature `(importPath: string, sourceFile: string) => string | null` matches `LanguageConfig`. The import-resolver test uses `/project/src/myutil.h` target, consistent with `path.resolve('/project/src', 'myutil.h')`.

**One deliberate deviation from the spec:** the spec's §Test item 4 said "强制走 regex 路径时函数/结构体/枚举仍能成块且名字正确" — the plan implements this as a manual verification (Task 4 Step 4) rather than a permanent unit test, because tree-sitter-c reliably parses so `chunkCode` never reaches the regex path for `.c`, and the repo has no established mechanism to force the fallback (C++/Python/etc. regex fallbacks are likewise untested). This matches "测试遵循仓库惯例" from the spec's §Test.
