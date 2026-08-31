import { load as yamlLoad } from 'js-yaml'
import type { AdrFrontmatter, AdrCodeAnchor, AdrTrigger } from './types.js'

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n?/

/**
 * Parse YAML frontmatter from an ADR markdown file.
 * Returns null if no valid frontmatter is found.
 */
export function parseFrontmatter(content: string): AdrFrontmatter | null {
  if (!content) return null

  const match = FRONTMATTER_PATTERN.exec(content)
  if (!match) return null

  try {
    const raw = yamlLoad(match[1]) as Record<string, unknown>
    if (!raw || typeof raw.id !== 'string') return null

    // Parse code_anchors
    const codeAnchors: AdrCodeAnchor[] = []
    if (Array.isArray(raw.code_anchors)) {
      for (const anchor of raw.code_anchors) {
        if (anchor && typeof anchor === 'object') {
          const a = anchor as Record<string, unknown>
          codeAnchors.push({
            file: String(a.file ?? ''),
            symbols: Array.isArray(a.symbols) ? a.symbols.map(String) : [],
            lines: Array.isArray(a.lines) && a.lines.length === 2
              ? [Number(a.lines[0]), Number(a.lines[1])] as [number, number]
              : [0, 0],
            git_commit: String(a.git_commit ?? ''),
          })
        }
      }
    }

    // Parse trigger
    const triggerRaw = (raw.trigger ?? {}) as Record<string, unknown>
    const trigger: AdrTrigger = {
      task_id: triggerRaw.task_id != null ? String(triggerRaw.task_id) : null,
      requirement_summary: String(triggerRaw.requirement_summary ?? ''),
      change_type: String(triggerRaw.change_type ?? ''),
    }

    // Parse related_decisions
    const relatedDecisions: string[] = Array.isArray(raw.related_decisions)
      ? raw.related_decisions.map(String)
      : []

    return {
      id: String(raw.id),
      type: String(raw.type ?? 'decision-record'),
      status: (raw.status === 'superseded' || raw.status === 'deprecated') ? raw.status : 'active',
      created: String(raw.created ?? ''),
      updated: String(raw.updated ?? ''),
      author: String(raw.author ?? ''),
      supersedes: raw.supersedes && raw.supersedes !== 'null' ? String(raw.supersedes) : null,
      superseded_by: raw.superseded_by && raw.superseded_by !== 'null' ? String(raw.superseded_by) : null,
      code_anchors: codeAnchors,
      trigger,
      related_decisions: relatedDecisions,
      auto_generated: raw.auto_generated === true,
    }
  } catch {
    return null
  }
}