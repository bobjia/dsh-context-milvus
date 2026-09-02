/**
 * Tree-sitter based code chunker with regex fallback.
 *
 * Uses tree-sitter AST for TypeScript/JavaScript/Python/Java/Go/Rust/C++/C#/Scala
 * (which works with the installed version). For other languages (PHP),
 * uses a regex-based fallback that detects function/class/method boundaries.
 *
 * The regex fallback is less precise than AST parsing but covers the
 * most common patterns in each language.
 */

import * as path from 'node:path'
import { createRequire } from 'node:module'
import type { LanguageConfig, CodeChunk } from './types.js'

const require = createRequire(import.meta.url)

// ── Language definitions ───────────────────────────────────────────────

interface LanguageDef {
  config: LanguageConfig
  /** Load the tree-sitter Language object (sync for CJS, async for ESM packages) */
  loadTs?: () => any | Promise<any>
}

const LANGUAGES: LanguageDef[] = [
  {
    config: {
      name: 'typescript',
      extensions: ['.ts', '.tsx', '.mts', '.cts'],
      chunkNodeTypes: [
        'function_declaration',
        'method_definition',
        'class_declaration',
        'interface_declaration',
        'enum_declaration',
        'type_alias_declaration',
        'arrow_function',
        'generator_function_declaration',
        'getter',
        'setter',
      ],
      referenceNodeTypes: [
        'call_expression',
        'import_statement',
        'import_specifier',
        'member_expression',
        'identifier',
      ],
      importNodeTypes: ['import_statement'],
      exportNodeTypes: ['export_statement'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // Only handle relative paths: './foo' or '../foo'
        if (!importPath.startsWith('.')) return null
        const dir = path.dirname(sourceFile)
        const resolved = path.resolve(dir, importPath)
        // V2: return best-guess path with .ts extension (no existence check)
        return resolved + '.ts'
      },
    },
    loadTs: () => require('tree-sitter-typescript').typescript,
  },
  {
    config: {
      name: 'javascript',
      extensions: ['.js', '.jsx', '.mjs', '.cjs'],
      chunkNodeTypes: [
        'function_declaration',
        'method_definition',
        'class_declaration',
        'arrow_function',
        'generator_function_declaration',
        'getter',
        'setter',
      ],
      referenceNodeTypes: ['call_expression', 'import_statement', 'import_specifier', 'member_expression', 'identifier'],
      importNodeTypes: ['import_statement'],
      exportNodeTypes: ['export_statement'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        if (!importPath.startsWith('.')) return null
        const dir = path.dirname(sourceFile)
        const resolved = path.resolve(dir, importPath)
        // V2: return best-guess path with .js extension (no existence check)
        return resolved + '.js'
      },
    },
    loadTs: () => require('tree-sitter-typescript').tsx,
  },
  {
    config: {
      name: 'python',
      extensions: ['.py'],
      chunkNodeTypes: [
        'function_definition',
        'class_definition',
        'async_function_definition',
        'decorated_definition',
      ],
      referenceNodeTypes: ['call', 'import_statement', 'import_from_statement', 'attribute', 'identifier'],
      importNodeTypes: ['import_from_statement', 'import_statement'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // from .foo import bar → ./foo.py
        // from foo import bar → ./foo.py (absolute, same package)
        const dir = path.dirname(sourceFile)
        // Relative: starts with '.'
        if (importPath.startsWith('.')) {
          const resolved = path.resolve(dir, importPath)
          return resolved + '.py'
        }
        // Absolute: try same directory
        const candidate = path.resolve(dir, importPath + '.py')
        // Just return the best guess; existence check is at index time
        return candidate
      },
    },
    loadTs: () => require('tree-sitter-python'),
  },
  {
    config: {
      name: 'rust',
      extensions: ['.rs'],
      chunkNodeTypes: [
        'function_item',
        'impl_item',
        'trait_item',
        'struct_item',
        'enum_item',
        'type_item',
        'const_item',
        'static_item',
        'macro_definition',
      ],
      referenceNodeTypes: ['call_expression', 'use_declaration', 'scoped_use_list', 'field_expression', 'identifier'],
      importNodeTypes: ['use_declaration'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // use crate::module::func → ./module.rs
        // use super::module::func → ../module.rs
        if (!importPath) return null
        const dir = path.dirname(sourceFile)
        // Remove crate:: or self:: prefix
        let resolved = importPath
          .replace(/^crate::/, '')
          .replace(/^self::/, '')
          .replace(/^super::/, '../')
        // Take just the module path (first component)
        const parts = resolved.split('::')
        const modulePath = parts.slice(0, -1).join('/') // exclude the function name
        return path.resolve(dir, modulePath + '.rs')
      },
    },
    loadTs: () => require('tree-sitter-rust'),
  },
  {
    config: {
      name: 'go',
      extensions: ['.go'],
      chunkNodeTypes: [
        'function_declaration',
        'method_declaration',
        'type_declaration',
        'type_spec',
      ],
      referenceNodeTypes: ['call_expression', 'import_declaration', 'selector_expression', 'identifier'],
      importNodeTypes: ['import_declaration'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // Go imports are package paths: "github.com/foo/bar"
        // Map to directory: sourceFile's dir + last segment of import path
        // e.g., import "github.com/foo/bar" → ./vendor/bar/ (package-level)
        if (!importPath) return null
        const dir = path.dirname(sourceFile)
        const pkgName = path.basename(importPath)
        // Try to find the package directory relative to source
        // For V2, just return the directory path
        const pkgDir = path.resolve(dir, pkgName)
        // If it exists as a directory, great; otherwise return null
        return pkgDir  // Caller will check existence
      },
    },
    loadTs: () => require('tree-sitter-go'),
  },
  {
    config: {
      name: 'java',
      extensions: ['.java'],
      chunkNodeTypes: [
        'class_declaration',
        'interface_declaration',
        'enum_declaration',
        'method_declaration',
        'constructor_declaration',
        'record_declaration',
      ],
      referenceNodeTypes: ['method_invocation', 'import_declaration', 'field_access', 'identifier'],
      importNodeTypes: ['import_declaration'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // import com.example.Foo → ./com/example/Foo.java
        if (!importPath) return null
        const srcDir = path.dirname(path.dirname(sourceFile)) // go up to src root
        const filePath = importPath.replace(/\./g, '/') + '.java'
        return path.resolve(srcDir, filePath)
      },
    },
    loadTs: () => require('tree-sitter-java'),
  },
  {
    config: {
      name: 'php',
      extensions: ['.php'],
      chunkNodeTypes: [
        'function_definition',
        'class_declaration',
        'interface_declaration',
        'trait_declaration',
        'enum_declaration',
      ],
    },
  },
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
      referenceNodeTypes: ['call_expression', 'using_directive', 'field_expression', 'identifier'],
      importNodeTypes: ['preproc_include'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // #include "header.hpp" → ./header.hpp
        if (!importPath) return null
        const dir = path.dirname(sourceFile)
        return path.resolve(dir, importPath)
      },
    },
    loadTs: () => require('tree-sitter-cpp'),
  },
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
      referenceNodeTypes: ['call_expression', 'using_directive', 'field_expression', 'identifier'],
      importNodeTypes: ['using_directive'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // using Project.Namespace → ./Project/Namespace/ (directory-level)
        if (!importPath) return null
        const dir = path.dirname(path.dirname(sourceFile))
        const pathSegments = importPath.replace(/\./g, '/')
        return path.resolve(dir, pathSegments)
      },
    },
    loadTs: async () => {
      const mod = await import('tree-sitter-c-sharp')
      return mod.default || mod
    },
  },
  {
    config: {
      name: 'scala',
      extensions: ['.scala'],
      chunkNodeTypes: [
        'class_definition',
        'function_definition',
        'function_declaration',
        'trait_definition',
        'object_definition',
        'constructor_definition',
      ],
      referenceNodeTypes: ['apply_expression', 'import', 'select_expression', 'identifier'],
      importNodeTypes: ['import'],
      resolveImportPath: (importPath: string, sourceFile: string) => {
        // import com.example.Foo → ./com/example/Foo.scala
        if (!importPath) return null
        const srcDir = path.dirname(path.dirname(sourceFile))
        const filePath = importPath.replace(/\./g, '/') + '.scala'
        return path.resolve(srcDir, filePath)
      },
    },
    loadTs: () => require('tree-sitter-scala'),
  },
]

// Build extension → config map
const EXT_MAP = new Map<string, LanguageDef>()
for (const def of LANGUAGES) {
  for (const ext of def.config.extensions) {
    EXT_MAP.set(ext, def)
  }
}

// Parser cache
const parserCache = new Map<string, any>()

async function createTsParser(def: LanguageDef): Promise<any> {
  if (!def.loadTs) throw new Error(`No tree-sitter parser for ${def.config.name}`)
  const Parser = require('tree-sitter')
  const parser = new Parser()
  // Promise.resolve handles both sync and async loadTs
  const lang = await Promise.resolve(def.loadTs())
  parser.setLanguage(lang)
  return parser
}

export async function getParser(ext: string): Promise<any> {
  let cached = parserCache.get(ext)
  if (!cached) {
    const def = EXT_MAP.get(ext)
    if (!def) throw new Error(`Unsupported file extension: ${ext}`)
    cached = createTsParser(def)
    parserCache.set(ext, cached)
  }
  return cached
}

/** Check if tree-sitter is available for a given extension */
export function hasTsParser(ext: string): boolean {
  const def = EXT_MAP.get(ext)
  return !!def?.loadTs
}

// ── Public API ─────────────────────────────────────────────────────────

export function getLanguageForExtension(ext: string): LanguageConfig | undefined {
  return EXT_MAP.get(ext.toLowerCase())?.config
}

export function isSupportedExtension(ext: string): boolean {
  return EXT_MAP.has(ext.toLowerCase())
}

export function extensionToLanguage(ext: string): string | undefined {
  return EXT_MAP.get(ext.toLowerCase())?.config.name
}

export function getSupportedExtensions(): string[] {
  return Array.from(EXT_MAP.keys())
}

// ── Tree-sitter chunking (for TypeScript/JavaScript) ───────────────────

function extractNodeName(node: any): string {
  const nameNode =
    node.childForFieldName('name') ??
    node.childForFieldName('type') ??
    node.childForFieldName('identifier')
  if (nameNode) return nameNode.text

  for (const child of node.namedChildren) {
    const t = child.type
    if (t === 'identifier' || t === 'type_identifier' || t === 'property_identifier') {
      return child.text
    }
  }
  return `anonymous_${node.type}`
}

/** Language keywords to exclude from references */
const LANGUAGE_KEYWORDS = new Set([
  'return', 'const', 'let', 'var', 'if', 'else', 'for', 'while', 'do', 'switch',
  'case', 'break', 'continue', 'throw', 'try', 'catch', 'finally', 'async', 'await',
  'yield', 'new', 'typeof', 'instanceof', 'void', 'delete', 'import', 'export',
  'default', 'from', 'as', 'in', 'of', 'this', 'super', 'class', 'function',
  'interface', 'enum', 'type', 'extends', 'implements', 'static', 'public',
  'private', 'protected', 'abstract', 'readonly', 'declare', 'module', 'namespace',
  'require', 'true', 'false', 'null', 'undefined', 'any', 'string', 'number',
  'boolean', 'void', 'never', 'unknown', 'bigint', 'symbol',
])

/** Symbols too generic to be useful as references */
const COMMON_WORDS = new Set([
  'data', 'config', 'result', 'process', 'error', 'value', 'item', 'args',
  'options', 'tmp', 'temp', 'key', 'val', 'name', 'type', 'size', 'length',
  'index', 'count', 'total', 'status', 'msg', 'err', 'str', 'num', 'obj',
  'arr', 'fn', 'cb', 'done', 'next', 'promise', 'callback', 'resolve',
  'reject', 'then', 'catch', 'finally', 'map', 'filter', 'reduce', 'forEach',
  'some', 'every', 'find', 'flat', 'flatMap', 'sort', 'reverse', 'includes',
])

/** Extract referenced symbols from a chunk's AST node */
function extractReferences(node: any, ownName: string, refTypes: Set<string>): string[] {
  const refs = new Set<string>()

  function walk(n: any) {
    if (!n || !n.type) return
    if (refTypes.has(n.type)) {
      const symbol = extractSymbolFromNode(n)
      if (symbol && symbol.length > 1 && !LANGUAGE_KEYWORDS.has(symbol) && !COMMON_WORDS.has(symbol) && symbol !== ownName) {
        refs.add(symbol)
      }
    }
    if (n.childCount > 0) {
      for (const child of n.children) {
        walk(child)
      }
    }
  }

  walk(node)
  return Array.from(refs)
}

/** Extract the symbol name from a reference node */
function extractSymbolFromNode(node: any): string | null {
  switch (node.type) {
    case 'call_expression': {
      // For a call like parseConfig(args), the function child has the name
      const fnNode = node.childForFieldName('function')
      return fnNode ? fnNode.text : null
    }
    case 'identifier':
    case 'type_identifier':
    case 'property_identifier':
      return node.text
    case 'member_expression':
    case 'field_expression':
    case 'select_expression':
    case 'attribute':
      return node.text  // e.g. "this.foo", "svc.start"
    case 'import_statement':
    case 'import_declaration':
    case 'import':
    case 'import_from_statement':
      // For import { X } from ..., collect imported identifiers
      // We collect the binding names, not module paths
      return null  // handled by child identifiers
    case 'import_specifier':
      // The imported name itself
      return node.childForFieldName('name')?.text ?? null
    case 'method_invocation':
      // Java: obj.method() → the method name
      return node.childForFieldName('name')?.text ?? null
    case 'apply_expression':
      // Scala: function(args) → the function node
      return node.childForFieldName('function')?.text ?? null
    default:
      return null
  }
}

function collectChunks(node: any, chunkTypes: Set<string>, depth: number, maxDepth: number): any[] {
  if (depth > maxDepth) return []
  const result: any[] = []
  if (chunkTypes.has(node.type)) result.push(node)
  if (node.childCount > 0) {
    for (const child of node.children) {
      result.push(...collectChunks(child, chunkTypes, depth + 1, maxDepth))
    }
  }
  return result
}

async function chunkWithTreeSitter(
  filePath: string, content: string, ext: string, def: LanguageDef,
): Promise<CodeChunk[]> {
  const parser = await getParser(ext)
  const tree = parser.parse(content)
  const root = tree.rootNode
  const chunkTypes = new Set(def.config.chunkNodeTypes)
  const nodes = collectChunks(root, chunkTypes, 0, 10)
  const seen = new Set<number>()

  return nodes
    .filter((n: any) => {
      if (seen.has(n.id)) return false
      seen.add(n.id)
      return true
    })
    .map((node: any) => {
      const ownName = extractNodeName(node)
      const refTypes = def.config.referenceNodeTypes
      const refSet = refTypes ? new Set<string>(refTypes) : new Set<string>()
      return {
        filePath,
        content: node.text,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        language: def.config.name,
        chunkType: node.type,
        name: ownName,
        references: extractReferences(node, ownName, refSet),
      }
    })
}

// ── Regex-based chunking (fallback for Python, Rust, Go, Java, PHP, C++, C#, Scala) ─────────

// Patterns for each language
const REGEX_PATTERNS: Record<string, RegExp[]> = {
  python: [
    // function definition
    /^(?:async\s+)?def\s+(\w+)\s*\(/gm,
    // class definition
    /^class\s+(\w+)\s*[:\(]/gm,
    // decorated definition
    /^@\w+/gm,
  ],
  rust: [
    // function
    /^(?:pub\s+)?(?:unsafe\s+)?fn\s+(\w+)/gm,
    // impl
    /^(?:pub\s+)?impl\s+(\w+)/gm,
    // trait
    /^(?:pub\s+)?trait\s+(\w+)/gm,
    // struct
    /^(?:pub\s+)?struct\s+(\w+)/gm,
    // enum
    /^(?:pub\s+)?enum\s+(\w+)/gm,
    // type
    /^(?:pub\s+)?type\s+(\w+)/gm,
    // macro
    /^(?:pub\s+)?macro_rules!\s*(\w+)/gm,
  ],
  go: [
    // function
    /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/gm,
    // type
    /^type\s+(\w+)\s+/gm,
  ],
  java: [
    // class
    /^(?:public\s+)?(?:abstract\s+)?class\s+(\w+)/gm,
    // interface
    /^(?:public\s+)?interface\s+(\w+)/gm,
    // enum
    /^(?:public\s+)?enum\s+(\w+)/gm,
    // record
    /^(?:public\s+)?record\s+(\w+)/gm,
    // method
    /^(?:public|private|protected)\s+(?:static\s+)?(?:\w+)\s+(\w+)\s*\(/gm,
  ],
  php: [
    // function (including public, private, protected, static, abstract)
    /^(?:(?:public|protected|private)\s+)?(?:static\s+)?(?:abstract\s+)?function\s+(?:\&\s*)?(\w+)\s*\(/gm,
    // class (including abstract, final, readonly)
    /^(?:abstract\s+|final\s+|readonly\s+)?class\s+(\w+)/gm,
    // interface
    /^interface\s+(\w+)/gm,
    // trait
    /^trait\s+(\w+)/gm,
    // enum
    /^enum\s+(\w+)/gm,
  ],
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
}

/** Determine the chunk type name from a regex match context (Python, Rust, Go, Java, PHP, C++, C#, Scala) */
function regexChunkType(language: string, match: RegExpExecArray, line: string): string {
  if (language === 'python') {
    if (/^class\s/.test(line)) return 'class_definition'
    if (/^@/.test(line)) return 'decorated_definition'
    return 'function_definition'
  }
  if (language === 'rust') {
    if (/^impl\s/.test(line)) return 'impl_item'
    if (/^trait\s/.test(line)) return 'trait_item'
    if (/^struct\s/.test(line)) return 'struct_item'
    if (/^enum\s/.test(line)) return 'enum_item'
    if (/^type\s/.test(line)) return 'type_item'
    if (/^macro_rules/.test(line)) return 'macro_definition'
    return 'function_item'
  }
  if (language === 'go') {
    if (/^type\s/.test(line)) return 'type_spec'
    return 'function_declaration'
  }
  if (language === 'java') {
    if (/^class\s/.test(line)) return 'class_declaration'
    if (/^interface\s/.test(line)) return 'interface_declaration'
    if (/^enum\s/.test(line)) return 'enum_declaration'
    if (/^record\s/.test(line)) return 'record_declaration'
    return 'method_declaration'
  }
  if (language === 'php') {
    if (/^class\s/.test(line)) return 'class_declaration'
    if (/^interface\s/.test(line)) return 'interface_declaration'
    if (/^trait\s/.test(line)) return 'trait_declaration'
    if (/^enum\s/.test(line)) return 'enum_declaration'
    return 'function_definition'
  }
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
  return 'unknown'
}

/** Find the end line of a chunk by scanning for the next top-level declaration or end of block */
function findChunkEnd(lines: string[], startIndex: number): number {
  if (startIndex >= lines.length) return startIndex

  const line = lines[startIndex]
  const indent = line.search(/\S|$/) // Leading whitespace

  // For brace-based languages, track brace depth
  let braceDepth = 0
  let hasBrace = false

  for (let i = startIndex; i < lines.length; i++) {
    const l = lines[i]

    // Count braces
    for (const ch of l) {
      if (ch === '{') { braceDepth++; hasBrace = true }
      if (ch === '}') braceDepth--
    }

    // If we've closed all braces, we're at the end
    if (hasBrace && braceDepth <= 0 && i > startIndex) {
      return i + 1
    }

    // For Python (indentation-based), detect when we're back to the same indent level
    if (!hasBrace && i > startIndex) {
      const currentIndent = l.search(/\S|$/)
      if (l.trim() !== '' && currentIndent <= indent && !l.trimStart().startsWith('@')) {
        // Check if this is a new top-level declaration
        const trimmed = l.trimStart()
        if (trimmed.startsWith('def ') || trimmed.startsWith('class ') || trimmed.startsWith('@') || trimmed.startsWith('async ')) {
          return i
        }
      }
    }
  }
  return lines.length
}

function chunkWithRegex(
  filePath: string, content: string, ext: string, def: LanguageDef,
): CodeChunk[] {
  const language = def.config.name
  const patterns = REGEX_PATTERNS[language]
  if (!patterns) return []

  const lines = content.split('\n')
  const chunks: CodeChunk[] = []
  const seenNames = new Set<string>()

  for (const pattern of patterns) {
    pattern.lastIndex = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(content)) !== null) {
      const name = match[1] || `anonymous_${match[0].trim().split(/\s+/)[0]}`
      const lineIndex = content.slice(0, match.index).split('\n').length - 1
      const startLine = lineIndex + 1 // 1-based

      // Deduplicate by name + startLine
      const key = `${name}:${startLine}`
      if (seenNames.has(key)) continue
      seenNames.add(key)

      const endLine = findChunkEnd(lines, lineIndex)
      const chunkContent = lines.slice(lineIndex, endLine).join('\n').trim()
      if (!chunkContent) continue

      chunks.push({
        filePath,
        content: chunkContent,
        startLine,
        endLine: Math.min(endLine, lines.length),
        language,
        chunkType: regexChunkType(language, match, match[0]),
        name,
      })
    }
  }

  return chunks
}

// ── Main chunking entry point ──────────────────────────────────────────

/**
 * Parse a source file and extract semantic code chunks.
 *
 * Uses tree-sitter AST for TypeScript/JavaScript, regex fallback for others.
 */
export async function chunkCode(filePath: string, content: string, ext: string): Promise<CodeChunk[]> {
  const def = EXT_MAP.get(ext.toLowerCase())
  if (!def) throw new Error(`Unsupported file extension: ${ext}`)

  // Try tree-sitter first
  if (hasTsParser(ext)) {
    try {
      return await chunkWithTreeSitter(filePath, content, ext, def)
    } catch {
      // Tree-sitter failed — fall through to regex
    }
  }

  // Regex fallback
  return chunkWithRegex(filePath, content, ext, def)
}