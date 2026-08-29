# Code Splitting Enhancement & Ignore Pattern System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enhance code chunker with more tree-sitter language support and replace hardcoded directory skipping with a gitignore-style ignore pattern system.

**Architecture:** Two independent features: (1) add `loadTs` to existing language definitions in `chunker.ts` and add C++/C#/Scala as new languages; (2) create `ignore-matcher.ts` with three-layer ignore pattern system and refactor `indexer.ts` to use it.

**Tech Stack:** tree-sitter (AST parsing), ignore (gitignore-style pattern matching), TypeScript, Jest

## Global Constraints

- New tree-sitter packages: `tree-sitter-cpp@^0.23.4`, `tree-sitter-c-sharp@^0.23.5`, `tree-sitter-scala@^0.24.0`
- New ignore package: `ignore@^7.0.0`
- Follow existing `LanguageDef` pattern in `chunker.ts`
- Keep regex fallback for PHP and any unsupported languages
- `indexIgnoreDirs` config field must remain backward compatible
- Global ignore file path: `~/.context/.contextignore`
- All existing tests must continue to pass after each task

---

## File Structure

### Feature 1: Code Splitting Enhancement

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add 3 new tree-sitter dependencies |
| `src/plugins/dsh-context-milvus/chunker.ts` | Modify | Add `loadTs` to Python/Java/Go/Rust; add C++/C#/Scala entries; add regex fallback patterns for new languages |
| `src/plugins/dsh-context-milvus/config.ts` | Modify | Add C++/C#/Scala to `DEFAULT_EXTENSIONS` |
| `test/dsh-context-remdb.spec.ts` | Modify | Add chunker tests for Java, Go, C++, C#, Scala |

### Feature 2: Ignore Pattern System

| File | Action | Responsibility |
|------|--------|----------------|
| `package.json` | Modify | Add `ignore` dependency |
| `src/plugins/dsh-context-milvus/ignore-matcher.ts` | Create | `IgnoreMatcher` class with gitignore-style matching |
| `src/plugins/dsh-context-milvus/config.ts` | Modify | Add `DEFAULT_IGNORE_PATTERNS`, `ignorePatterns` config field |
| `src/plugins/dsh-context-milvus/indexer.ts` | Modify | Refactor `walkDirectory` to use `IgnoreMatcher`; add ignore file loading in `runIndex` |
| `test/dsh-context-remdb.spec.ts` | Modify | Add ignore matcher tests |

---

## Tasks

### Task 1: Install new tree-sitter packages

- [ ] **Step 1: Install packages**

```bash
npm install tree-sitter-cpp@^0.23.4 tree-sitter-c-sharp@^0.23.5 tree-sitter-scala@^0.24.0
```

- [ ] **Step 2: Verify installation**

```bash
node -e "require('tree-sitter-cpp'); require('tree-sitter-c-sharp'); require('tree-sitter-scala'); console.log('OK')"
```

Expected: prints `OK`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add tree-sitter-cpp, tree-sitter-c-sharp, tree-sitter-scala"
```

---

### Task 2: Update chunker.ts — add language support

**Files:**
- Modify: `src/plugins/dsh-context-milvus/chunker.ts`

**Interfaces:**
- Consumes: `LanguageDef` interface (already defined)
- Produces: Extended `LANGUAGES` array with 7 new/upgraded language entries

- [ ] **Step 1: Add `loadTs` to existing Python, Java, Go, Rust entries**

In the `LANGUAGES` array in `chunker.ts`, add `loadTs` to these entries:

**Python entry** — add after `chunkNodeTypes`:
```typescript
loadTs: () => require('tree-sitter-python'),
```

**Java entry** — add after `chunkNodeTypes`:
```typescript
loadTs: () => require('tree-sitter-java'),
```

**Go entry** — add after `chunkNodeTypes`:
```typescript
loadTs: () => require('tree-sitter-go'),
```

**Rust entry** — add after `chunkNodeTypes`:
```typescript
loadTs: () => require('tree-sitter-rust'),
```

- [ ] **Step 2: Add C++ language entry**

Add after the rust entry in the `LANGUAGES` array:
```typescript
{
  config: {
    name: 'cpp',
    extensions: ['.cpp', '.cxx', '.cc', '.hpp', '.h', '.hh'],
    chunkNodeTypes: [
      'function_definition',
      'class_specifier',
      'namespace_definition',
      'declaration',
      'struct_specifier',
      'enum_specifier',
    ],
  },
  loadTs: () => require('tree-sitter-cpp'),
},
```

- [ ] **Step 3: Add C# language entry**

Add after the cpp entry:
```typescript
{
  config: {
    name: 'csharp',
    extensions: ['.cs'],
    chunkNodeTypes: [
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'struct_declaration',
      'enum_declaration',
      'constructor_declaration',
    ],
  },
  loadTs: () => require('tree-sitter-c-sharp'),
},
```

- [ ] **Step 4: Add Scala language entry**

Add after the csharp entry:
```typescript
{
  config: {
    name: 'scala',
    extensions: ['.scala'],
    chunkNodeTypes: [
      'method_declaration',
      'class_declaration',
      'interface_declaration',
      'constructor_declaration',
    ],
  },
  loadTs: () => require('tree-sitter-scala'),
},
```

- [ ] **Step 5: Add regex fallback patterns for new languages**

Add to the `REGEX_PATTERNS` record (after the `php` entry):
```typescript
cpp: [
  /^(?:(?:virtual|inline|static|const|constexpr|noexcept)\s+)*(?:\w+(?:\s*\*|\s*&)?\s+)?(\w+)\s*\(/gm,
  /^class\s+(\w+)/gm,
  /^struct\s+(\w+)/gm,
  /^enum\s+(?:class\s+)?(\w+)/gm,
  /^namespace\s+(\w+)/gm,
],
csharp: [
  /^(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:partial\s+)?(?:class|struct|interface|record)\s+(\w+)/gm,
  /^(?:public|private|protected|internal)\s+(?:static\s+)?(?:async\s+)?(?:override\s+)?(?:\w+\s+)?(\w+)\s*\(/gm,
  /^enum\s+(\w+)/gm,
],
scala: [
  /^def\s+(\w+)/gm,
  /^class\s+(\w+)/gm,
  /^trait\s+(\w+)/gm,
  /^object\s+(\w+)/gm,
  /^enum\s+(\w+)/gm,
  /^case class\s+(\w+)/gm,
],
```

- [ ] **Step 6: Add regex chunk type detection for new languages**

Add to the `regexChunkType` function (before the `return 'unknown'` line):
```typescript
if (language === 'cpp') {
  if (/^class\s/.test(line)) return 'class_specifier'
  if (/^struct\s/.test(line)) return 'struct_specifier'
  if (/^enum\s/.test(line)) return 'enum_specifier'
  if (/^namespace\s/.test(line)) return 'namespace_definition'
  return 'function_definition'
}
if (language === 'csharp') {
  if (/^class\s/.test(line)) return 'class_declaration'
  if (/^interface\s/.test(line)) return 'interface_declaration'
  if (/^struct\s/.test(line)) return 'struct_declaration'
  if (/^enum\s/.test(line)) return 'enum_declaration'
  if (/^record\s/.test(line)) return 'record_declaration'
  return 'method_declaration'
}
if (language === 'scala') {
  if (/^class\s/.test(line)) return 'class_declaration'
  if (/^trait\s/.test(line)) return 'trait_declaration'
  if (/^object\s/.test(line)) return 'object_definition'
  if (/^enum\s/.test(line)) return 'enum_declaration'
  return 'method_declaration'
}
```

- [ ] **Step 7: Run existing tests to verify nothing is broken**

```bash
npx jest test/dsh-context-remdb.spec.ts --testNamePattern="chunkCode" 2>&1
```

Expected: all chunker tests pass

- [ ] **Step 8: Commit**

```bash
git add src/plugins/dsh-context-milvus/chunker.ts
git commit -m "feat: add tree-sitter support for Python, Java, Go, Rust, C++, C#, Scala"
```

---

### Task 3: Update config.ts — add new extensions

**Files:**
- Modify: `src/plugins/dsh-context-milvus/config.ts`

- [ ] **Step 1: Add C++, C#, Scala to `DEFAULT_EXTENSIONS`**

In `config.ts`, add after the `php` entry in `DEFAULT_EXTENSIONS`:
```typescript
cpp: ['.cpp', '.cxx', '.cc', '.hpp', '.h', '.hh'],
csharp: ['.cs'],
scala: ['.scala'],
```

- [ ] **Step 2: Run existing config tests**

```bash
npx jest test/dsh-context-remdb.spec.ts --testNamePattern="config" 2>&1
```

Expected: all config tests pass

- [ ] **Step 3: Commit**

```bash
git add src/plugins/dsh-context-milvus/config.ts
git commit -m "feat: add C++, C#, Scala to default indexed extensions"
```

---

### Task 4: Add chunker tests for new languages

**Files:**
- Modify: `test/dsh-context-remdb.spec.ts`

- [ ] **Step 1: Add Java chunker test**

Add after the Rust test (`it('extracts functions from Rust code')`) in the `describe('chunkCode (tree-sitter)')` block:

```typescript
it('extracts classes and methods from Java code', async () => {
  const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

  const code = `
public class Greeter {
    private String name;

    public Greeter(String name) {
        this.name = name;
    }

    public String greet(String greeting) {
        return greeting + " " + this.name;
    }
}

interface Logger {
    void log(String message);
}
`
  const chunks = chunkCode('/tmp/test.java', code, '.java')
  expect(chunks.length).toBeGreaterThanOrEqual(2)

  const cls = chunks.find((c) => c.name === 'Greeter')
  expect(cls).toBeDefined()
  expect(cls!.chunkType).toBe('class_declaration')

  const method = chunks.find((c) => c.name === 'greet')
  expect(method).toBeDefined()
  expect(method!.chunkType).toBe('method_declaration')
})
```

- [ ] **Step 2: Add Go chunker test**

Add after the Java test:

```typescript
it('extracts functions and types from Go code', async () => {
  const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

  const code = `
package main

func hello(name string) string {
    return "Hello " + name
}

type User struct {
    Name string
    Age  int
}

func (u *User) Greet() string {
    return "Hi " + u.Name
}
`
  const chunks = chunkCode('/tmp/test.go', code, '.go')
  expect(chunks.length).toBeGreaterThanOrEqual(2)

  const func_ = chunks.find((c) => c.name === 'hello')
  expect(func_).toBeDefined()
  expect(func_!.chunkType).toBe('function_declaration')

  const method = chunks.find((c) => c.name === 'Greet')
  expect(method).toBeDefined()
  expect(method!.chunkType).toBe('method_declaration')
})
```

- [ ] **Step 3: Add C++ chunker test**

Add after the Go test:

```typescript
it('extracts functions and classes from C++ code', async () => {
  const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

  const code = `
#include <string>

class Greeter {
private:
    std::string name;

public:
    Greeter(const std::string& name) : name(name) {}

    std::string greet(const std::string& greeting) {
        return greeting + " " + name;
    }
};

namespace utils {
    int add(int a, int b) {
        return a + b;
    }
}
`
  const chunks = chunkCode('/tmp/test.cpp', code, '.cpp')
  expect(chunks.length).toBeGreaterThanOrEqual(2)

  const cls = chunks.find((c) => c.name === 'Greeter')
  expect(cls).toBeDefined()
  expect(cls!.chunkType).toBe('class_specifier')
})
```

- [ ] **Step 4: Add C# chunker test**

Add after the C++ test:

```typescript
it('extracts classes and methods from C# code', async () => {
  const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

  const code = `
using System;

namespace HelloWorld
{
    public class Greeter
    {
        private string name;

        public Greeter(string name)
        {
            this.name = name;
        }

        public string Greet(string greeting)
        {
            return greeting + " " + name;
        }
    }

    public interface ILogger
    {
        void Log(string message);
    }
}
`
  const chunks = chunkCode('/tmp/test.cs', code, '.cs')
  expect(chunks.length).toBeGreaterThanOrEqual(2)

  const cls = chunks.find((c) => c.name === 'Greeter')
  expect(cls).toBeDefined()
  expect(cls!.chunkType).toBe('class_declaration')

  const iface = chunks.find((c) => c.name === 'ILogger')
  expect(iface).toBeDefined()
  expect(iface!.chunkType).toBe('interface_declaration')
})
```

- [ ] **Step 5: Add Scala chunker test**

Add after the C# test:

```typescript
it('extracts classes and methods from Scala code', async () => {
  const { chunkCode } = await import('../src/plugins/dsh-context-milvus/chunker.js')

  const code = `
class Greeter(name: String) {
    def greet(greeting: String): String = {
        greeting + " " + name
    }
}

trait Logger {
    def log(message: String): Unit
}

object Main {
    def main(args: Array[String]): Unit = {
        println("Hello")
    }
}
`
  const chunks = chunkCode('/tmp/test.scala', code, '.scala')
  expect(chunks.length).toBeGreaterThanOrEqual(2)

  const cls = chunks.find((c) => c.name === 'Greeter')
  expect(cls).toBeDefined()
  expect(cls!.chunkType).toBe('class_declaration')

  const trait_ = chunks.find((c) => c.name === 'Logger')
  expect(trait_).toBeDefined()
  expect(trait_!.chunkType).toBe('interface_declaration')
})
```

- [ ] **Step 6: Run all chunker tests**

```bash
npx jest test/dsh-context-remdb.spec.ts --testNamePattern="chunkCode" 2>&1
```

Expected: all 8+ chunker tests pass

- [ ] **Step 7: Commit**

```bash
git add test/dsh-context-remdb.spec.ts
git commit -m "test: add chunker tests for Java, Go, C++, C#, Scala"
```

---

### Task 5: Install ignore package

- [ ] **Step 1: Install package**

```bash
npm install ignore@^7.0.0
```

- [ ] **Step 2: Verify**

```bash
node -e "const i = require('ignore'); console.log(i().add('node_modules').ignores('node_modules/foo.js'))"
```

Expected: prints `true`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ignore package for gitignore-style pattern matching"
```

---

### Task 6: Create ignore-matcher.ts

**Files:**
- Create: `src/plugins/dsh-context-milvus/ignore-matcher.ts`

- [ ] **Step 1: Create the file**

```typescript
/**
 * IgnoreMatcher — gitignore-style pattern matching for code indexing.
 *
 * Supports three layers of ignore rules:
 * 1. Default patterns (built-in)
 * 2. Codebase ignore files (.gitignore, .ignore, .xxxignore)
 * 3. Global ignore file (~/.context/.contextignore)
 *
 * Uses the `ignore` npm package for gitignore-style pattern matching.
 * Additionally checks for hidden path segments (starting with ".") as
 * a safety net — consistent with claude-context's behavior.
 */

import ignore, { Ignore } from 'ignore'

export class IgnoreMatcher {
  private matcher: Ignore

  constructor(patterns: string[] = []) {
    const cleanPatterns = patterns
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0 && !pattern.startsWith('#'))

    this.matcher = ignore().add(cleanPatterns)
  }

  /**
   * Check if a path should be ignored.
   * @param relativePath — Path relative to the codebase root
   * @param isDirectory — Whether the path is a directory
   */
  ignores(relativePath: string, isDirectory: boolean = false): boolean {
    const normalizedPath = this.normalizePath(relativePath)
    if (!normalizedPath) {
      return false
    }

    // Auto-ignore hidden segments (paths starting with ".")
    if (this.hasHiddenSegment(normalizedPath)) {
      return true
    }

    // Gitignore-style matching
    if (this.matcher.ignores(normalizedPath)) {
      return true
    }

    // For directories, also check with trailing slash (gitignore convention)
    return isDirectory && this.matcher.ignores(`${normalizedPath}/`)
  }

  /**
   * Dynamically append additional patterns.
   */
  addPatterns(patterns: string[]): void {
    const cleanPatterns = patterns
      .map(pattern => pattern.trim())
      .filter(pattern => pattern.length > 0 && !pattern.startsWith('#'))

    if (cleanPatterns.length > 0) {
      this.matcher.add(cleanPatterns)
    }
  }

  private normalizePath(relativePath: string): string {
    return relativePath
      .replace(/\\/g, '/')     // Normalize backslashes
      .replace(/^\/+|\/+$/g, '') // Strip leading/trailing slashes
  }

  private hasHiddenSegment(relativePath: string): boolean {
    return relativePath
      .split('/')
      .some(part => part.length > 0 && part.startsWith('.'))
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add src/plugins/dsh-context-milvus/ignore-matcher.ts
git commit -m "feat: add IgnoreMatcher class for gitignore-style pattern matching"
```

---

### Task 7: Update config.ts — add ignore patterns

**Files:**
- Modify: `src/plugins/dsh-context-milvus/config.ts`

- [ ] **Step 1: Add `DEFAULT_IGNORE_PATTERNS` constant**

Add after `DEFAULT_IGNORE_DIRS`:
```typescript
/** Default gitignore-style ignore patterns */
export const DEFAULT_IGNORE_PATTERNS = [
  // Build output and dependency directories
  'node_modules/**',
  'dist/**', 'build/**', 'out/**',
  'target/**', 'coverage/**', '.nyc_output/**',

  // IDE and editor files
  '.vscode/**', '.idea/**',
  '*.swp', '*.swo',

  // Version control
  '.git/**', '.svn/**', '.hg/**',

  // Cache directories
  '.cache/**', '__pycache__/**', '.pytest_cache/**',

  // Logs and temporary files
  'logs/**', 'tmp/**', 'temp/**',
  '*.log',

  // Environment config
  '.env', '.env.*', '*.local',

  // Minified and bundled files
  '*.min.js', '*.min.css', '*.bundle.js', '*.map',

  // Directory names (bare, for gitignore-style dir matching)
  'node_modules', '.git', '.svn', '.hg',
  'dist', 'build', 'out', 'target',
  '.vscode', '.idea', '__pycache__', '.pytest_cache',
  'coverage', '.nyc_output', 'logs', 'tmp', 'temp',
]
```

- [ ] **Step 2: Add `ignorePatterns` to `CordisConfig`**

```typescript
export interface CordisConfig {
  // ... existing fields ...
  /** Custom ignore patterns (gitignore-style, comma-separated) */
  ignorePatterns?: string
}
```

- [ ] **Step 3: Add `ignorePatterns` to `PluginConfig`**

```typescript
export interface PluginConfig {
  // ... existing fields ...
  ignorePatterns: string[]   // Merged ignore patterns
}
```

- [ ] **Step 4: Update `getConfig()` to merge ignore patterns**

In the `getConfig` function, after the existing `indexIgnoreDirs` resolution:
```typescript
// Convert indexIgnoreDirs to gitignore-style patterns (backward compat)
const dirPatterns = (overrides?.indexIgnoreDirs ?? process.env.INDEX_IGNORE_DIRS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)
  .map(dir => `**/${dir}/**`)

// Parse custom ignore patterns
const customPatterns = (overrides?.ignorePatterns ?? process.env.IGNORE_PATTERNS ?? '')
  .split(',').map(s => s.trim()).filter(Boolean)
```

Then add `ignorePatterns` to the return object:
```typescript
return {
  // ... existing ...
  indexIgnoreDirs,
  ignorePatterns: [...dirPatterns, ...customPatterns],
}
```

- [ ] **Step 5: Run existing config tests**

```bash
npx jest test/dsh-context-remdb.spec.ts --testNamePattern="config" 2>&1
```

Expected: all config tests pass

- [ ] **Step 6: Commit**

```bash
git add src/plugins/dsh-context-milvus/config.ts
git commit -m "feat: add ignore pattern config and DEFAULT_IGNORE_PATTERNS"
```

---

### Task 8: Update indexer.ts — use IgnoreMatcher

**Files:**
- Modify: `src/plugins/dsh-context-milvus/indexer.ts`

**Interfaces:**
- Consumes: `IgnoreMatcher` from `ignore-matcher.ts`, `DEFAULT_IGNORE_PATTERNS` from `config.ts`
- Produces: Refactored `walkDirectory` that accepts `IgnoreMatcher` instead of `ignoreDirs: string[]`

- [ ] **Step 1: Add imports for IgnoreMatcher and DEFAULT_IGNORE_PATTERNS**

At the top of `indexer.ts`, add to the existing imports:
```typescript
import { IgnoreMatcher } from './ignore-matcher.js'
import { DEFAULT_IGNORE_PATTERNS } from './config.js'
```

- [ ] **Step 2: Add helper functions for loading ignore files**

Add before the `walkDirectory` function:
```typescript
/**
 * Find all ignore files (.gitignore, .ignore, .xxxignore) in the codebase root.
 */
async function findIgnoreFiles(codebasePath: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(codebasePath)
  } catch {
    return []
  }

  const ignoreFiles: string[] = []
  for (const entry of entries) {
    if (entry.startsWith('.') && entry.endsWith('ignore')) {
      ignoreFiles.push(path.join(codebasePath, entry))
    }
  }
  return ignoreFiles
}

/**
 * Read ignore patterns from a file.
 */
async function readIgnoreFile(filePath: string): Promise<string[]> {
  try {
    const content = await readFile(filePath, 'utf-8')
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
  } catch {
    return []
  }
}

/**
 * Load global ignore file from ~/.context/.contextignore.
 */
async function loadGlobalIgnoreFile(): Promise<string[]> {
  try {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ''
    if (!homeDir) return []
    const globalIgnorePath = path.join(homeDir, '.context', '.contextignore')
    return await readIgnoreFile(globalIgnorePath)
  } catch {
    return []
  }
}
```

- [ ] **Step 3: Refactor `walkDirectory` signature and body**

Change the function signature from:
```typescript
async function walkDirectory(
  rootDir: string,
  extensions: string[],
  ignoreDirs: string[],
  progress?: (filePath: string) => void,
): Promise<Map<string, string>>
```

To:
```typescript
async function walkDirectory(
  rootDir: string,
  extensions: string[],
  ignoreMatcher: IgnoreMatcher,
  progress?: (filePath: string) => void,
): Promise<Map<string, string>>
```

In the inner `walk` function, replace the entire skip logic block:
```typescript
// Remove:
// Skip hidden directories, VCS dirs, node_modules, and configured ignore dirs
if (entry === '.git' || entry === '.hg' || entry === '.svn') continue
if (entry === 'node_modules') continue
if (entry.startsWith('.') && entry !== '.') continue
if (ignoreSet.has(entry)) continue

// Replace with:
// Check ignore patterns
const relativePath = path.relative(rootDir, fullPath)
if (ignoreMatcher.ignores(relativePath, stats.isDirectory())) continue
```

Also remove the `const ignoreSet = new Set(ignoreDirs)` line at the top of `walkDirectory`.

- [ ] **Step 4: Update `runIndex` to create and configure IgnoreMatcher**

In the `runIndex` function, before calling `walkDirectory`, add:
```typescript
// Create ignore matcher with default + custom patterns
const ignoreMatcher = new IgnoreMatcher([
  ...DEFAULT_IGNORE_PATTERNS,
  ...config.ignorePatterns,
])

// Load codebase-specific ignore files
const ignoreFiles = await findIgnoreFiles(config.indexRoot)
for (const ignoreFile of ignoreFiles) {
  const patterns = await readIgnoreFile(ignoreFile)
  ignoreMatcher.addPatterns(patterns)
}

// Load global ignore file
const globalPatterns = await loadGlobalIgnoreFile()
ignoreMatcher.addPatterns(globalPatterns)
```

Then update the `walkDirectory` call:
```typescript
// From:
const currentFiles = await walkDirectory(
  config.indexRoot,
  config.indexExtensions,
  config.indexIgnoreDirs,
  onFileProgress,
)

// To:
const currentFiles = await walkDirectory(
  config.indexRoot,
  config.indexExtensions,
  ignoreMatcher,
  onFileProgress,
)
```

- [ ] **Step 5: Run existing tests**

```bash
npx jest test/dsh-context-remdb.spec.ts 2>&1
```

Expected: all tests pass

- [ ] **Step 6: Commit**

```bash
git add src/plugins/dsh-context-milvus/indexer.ts
git commit -m "feat: replace hardcoded dir skipping with IgnoreMatcher in indexer"
```

---

### Task 9: Add ignore matcher tests

**Files:**
- Modify: `test/dsh-context-remdb.spec.ts`

- [ ] **Step 1: Add ignore matcher test block**

Add at the end of the test file (before any closing braces):

```typescript
describe('IgnoreMatcher', () => {
  it('ignores node_modules directory', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['node_modules/**', 'node_modules'])
    expect(m.ignores('node_modules/some/file.js', false)).toBe(true)
    expect(m.ignores('node_modules', true)).toBe(true)
  })

  it('ignores .git directory', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['.git/**', '.git'])
    expect(m.ignores('.git/HEAD', false)).toBe(true)
    expect(m.ignores('.git', true)).toBe(true)
  })

  it('does not ignore source files', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['node_modules/**', '.git/**'])
    expect(m.ignores('src/index.ts', false)).toBe(false)
    expect(m.ignores('src/utils/helper.ts', false)).toBe(false)
  })

  it('ignores hidden segments', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher([])
    expect(m.ignores('.vscode/settings.json', false)).toBe(true)
    expect(m.ignores('.github/workflows/ci.yml', false)).toBe(true)
  })

  it('supports wildcard patterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['*.log', 'dist/**', '*.min.js'])
    expect(m.ignores('app.log', false)).toBe(true)
    expect(m.ignores('dist/bundle.js', false)).toBe(true)
    expect(m.ignores('dist/sub/bundle.js', false)).toBe(true)
    expect(m.ignores('app.min.js', false)).toBe(true)
    expect(m.ignores('src/index.ts', false)).toBe(false)
  })

  it('supports dynamic addPatterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['node_modules/**'])
    expect(m.ignores('src/file.ts', false)).toBe(false)
    m.addPatterns(['*.log'])
    expect(m.ignores('app.log', false)).toBe(true)
  })

  it('handles empty patterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher([])
    expect(m.ignores('src/file.ts', false)).toBe(false)
  })

  it('ignores comment lines and empty patterns', async () => {
    const { IgnoreMatcher } = await import('../src/plugins/dsh-context-milvus/ignore-matcher.js')
    const m = new IgnoreMatcher(['# comment', '', 'node_modules/**'])
    expect(m.ignores('node_modules/pkg/index.js', false)).toBe(true)
    expect(m.ignores('src/main.ts', false)).toBe(false)
  })
})
```

- [ ] **Step 2: Run ignore matcher tests**

```bash
npx jest test/dsh-context-remdb.spec.ts --testNamePattern="IgnoreMatcher" 2>&1
```

Expected: all 7 tests pass

- [ ] **Step 3: Run full test suite**

```bash
npx jest 2>&1
```

Expected: all tests pass

- [ ] **Step 4: Commit**

```bash
git add test/dsh-context-remdb.spec.ts
git commit -m "test: add IgnoreMatcher unit tests"
```