import { parseFrontmatter } from './adr-frontmatter.js'
import type { AdrChunk } from './types.js'

/** Section heading → section label mapping */
const SECTION_MAP: Record<string, string> = {
  '决策目标': 'goal',
  '约束条件': 'constraints',
  '候选方案与权衡': 'alternatives',
  '关键设计细节与隐性约束': 'hidden_constraints',
  '被否决的模式/反模式': 'rejected',
  '相关测试': 'tests',
  '变更边界': 'boundary',
}

const SECTION_HEADING_RE = /^## (.+)$/m

/**
 * Split an ADR markdown file into section chunks.
 * Each ## heading becomes a separate chunk.
 * The frontmatter is parsed for metadata; sections without ## headings
 * are not chunked.
 */
export async function chunkAdrFile(filePath: string, content: string): Promise<AdrChunk[]> {
  const frontmatter = parseFrontmatter(content)
  if (!frontmatter) return []

  // Remove frontmatter line for section splitting
  const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
  if (!body) return []

  const lines = body.split('\n')
  const chunks: AdrChunk[] = []
  let currentSection = ''
  let currentLines: string[] = []
  let currentStartLine = 0
  // Count frontmatter lines for offset
  const fmMatch = content.match(/^---[\s\S]*?---\n?/)
  const fmLineCount = fmMatch ? fmMatch[0].split('\n').length : 0
  let lineOffset = fmLineCount

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const headingMatch = line.match(/^## (.+)/)

    if (headingMatch) {
      // Flush previous section
      if (currentSection && currentLines.length > 0) {
        const sectionLabel = SECTION_MAP[currentSection] || currentSection
        chunks.push({
          filePath,
          adrId: frontmatter.id,
          docType: 'adr',
          section: sectionLabel,
          content: currentLines.join('\n').trim(),
          startLine: currentStartLine + lineOffset,
          endLine: i + lineOffset - 1,
          status: frontmatter.status,
          codeAnchors: frontmatter.code_anchors.map(a => a.file),
          triggerType: frontmatter.trigger.change_type,
        })
      }
      currentSection = headingMatch[1].trim()
      currentLines = []
      currentStartLine = i + 1
    } else {
      currentLines.push(line)
    }
  }

  // Flush last section
  if (currentSection && currentLines.length > 0) {
    const sectionLabel = SECTION_MAP[currentSection] || currentSection
    chunks.push({
      filePath,
      adrId: frontmatter.id,
      docType: 'adr',
      section: sectionLabel,
      content: currentLines.join('\n').trim(),
      startLine: currentStartLine + lineOffset,
      endLine: lines.length + lineOffset,
      status: frontmatter.status,
      codeAnchors: frontmatter.code_anchors.map(a => a.file),
      triggerType: frontmatter.trigger.change_type,
    })
  }

  return chunks
}
