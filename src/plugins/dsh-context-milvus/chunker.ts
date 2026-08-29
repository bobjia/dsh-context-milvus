/**
 * Tree-sitter based code chunker with regex fallback.
 *
 * Uses tree-sitter AST for TypeScript/JavaScript (which works with the
 * installed version). For other languages (Python, Rust, Go, Java, PHP),
 * uses a regex-based fallback that detects function/class/method boundaries.
 *
 * The regex fallback is less precise than AST parsing but covers the
 * most common patterns in each language.
 */

import { createRequire } from 'node:module'
import type { LanguageConfig, CodeChunk } from './types.js'

const require = createRequire(import.meta.url)

// ── Language definitions ───────────────────────────────────────────────

interface LanguageDef {
  config: LanguageConfig
  /** Load the tree-sitter Language object (may throw if incompatible) */
  loadTs?: () => any
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
    },
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
    },
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
    },
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
    },
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

function createTsParser(def: LanguageDef): any {
  if (!def.loadTs) throw new Error(`No tree-sitter parser for ${def.config.name}`)
  const Parser = require('tree-sitter')
  const parser = new Parser()
  parser.setLanguage(def.loadTs())
  return parser
}

function getParser(ext: string): any {
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
function hasTsParser(ext: string): boolean {
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

function chunkWithTreeSitter(
  filePath: string, content: string, ext: string, def: LanguageDef,
): CodeChunk[] {
  const parser = getParser(ext)
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
    .map((node: any) => ({
      filePath,
      content: node.text,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      language: def.config.name,
      chunkType: node.type,
      name: extractNodeName(node),
    }))
}

// ── Regex-based chunking (fallback for Python, Rust, Go, Java) ─────────

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
}

/** Determine the chunk type name from a regex match context */
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
export function chunkCode(filePath: string, content: string, ext: string): CodeChunk[] {
  const def = EXT_MAP.get(ext.toLowerCase())
  if (!def) throw new Error(`Unsupported file extension: ${ext}`)

  // Try tree-sitter first (for TypeScript/JavaScript)
  if (hasTsParser(ext)) {
    try {
      return chunkWithTreeSitter(filePath, content, ext, def)
    } catch {
      // Tree-sitter failed — fall through to regex
    }
  }

  // Regex fallback
  return chunkWithRegex(filePath, content, ext, def)
}