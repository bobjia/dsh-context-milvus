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