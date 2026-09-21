/**
 * Path helpers for Milvus filter expressions and cross-adapter path comparison.
 *
 * Windows stores code paths with backslashes (`C:\repo\src\a.ts`), and the
 * Milvus expr grammar treats `\` as an escape character inside double-quoted
 * string literals — `C:\ws` in a filter is a syntax error because `\w` is not
 * a legal escape sequence, and `"` must be escaped too. Every filter value that
 * interpolates a path must go through `buildFilePathLike` / `buildFilePathEq`;
 * the escaping is centralised here so a correction (e.g. if a Milvus LIKE layer
 * turns out to double-unescape backslashes) touches one place.
 */

import * as path from 'node:path'

/**
 * Escape a value for a double-quoted Milvus expr string literal.
 * `\` → `\\`, `"` → `\"`.
 */
export function exprEscapeString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Normalize a path for filtering against natively-stored file_path values.
 * Forward slashes become the native separator, so a user typing `C:/repo` on
 * Windows still matches stored `C:\repo\...`. `sep` is injectable so the
 * Windows behaviour is testable on POSIX.
 */
export function normalizeFilterPath(value: string, sep: string = path.sep): string {
  return value.split('/').join(sep)
}

/**
 * Convert a path to forward-slash form for cross-platform key comparison
 * (ADR anchor keys are stored posix). Never used for filesystem operations.
 */
export function toPosixPath(value: string): string {
  return value.replace(/\\/g, '/')
}

/**
 * `file_path like "<prefix>%"` expression for a path prefix. The prefix is
 * normalized to native separators and escaped; a trailing separator is stripped
 * so the wildcard is not swallowed (a trailing `\` before `%` would make the
 * pattern depend on how the LIKE layer treats an escaped `%`).
 */
export function buildFilePathLike(prefix: string, sep: string = path.sep): string {
  const normalized = normalizeFilterPath(prefix, sep).replace(/[\\/]+$/, '')
  return `file_path like "${exprEscapeString(normalized)}%"`
}

/** `file_path == "<filePath>"` expression for an exact path match. */
export function buildFilePathEq(filePath: string): string {
  return `file_path == "${exprEscapeString(filePath)}"`
}
