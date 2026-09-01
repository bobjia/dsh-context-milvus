import { readFile, writeFile, readdir, mkdir, rename } from 'node:fs/promises'
import * as path from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { parseFrontmatter } from './adr-frontmatter.js'
import type {
  AdrFrontmatter, AdrDocument, AdrListItem, ConstraintSummary,
  CreateAdrParams, UpdateAdrParams, AdrFilter,
} from './types.js'

const ADR_FILENAME_RE = /^ADR-(\d{4})-(.+)\.md$/
const ADR_STATUSES: ReadonlySet<string> = new Set(['active', 'superseded', 'deprecated'])
const DEFAULT_TEMPLATE = `---
id: ADR-{serial}-{title}
type: decision-record
status: active
created: {created}
updated: {created}
author: dsh-context-milvus
supersedes: {supersedes}
superseded_by: null
code_anchors: []
trigger:
  task_id: null
  requirement_summary: "{requirement}"
  change_type: {change_type}
related_decisions: []
auto_generated: false
---

## 决策目标

{description}

## 约束条件

{constraints}

## 候选方案与权衡

### 方案A：{方案名称}
- **描述**：{方案简要说明}
- **优点**：{列出优点}
- **缺点**：{列出缺点}
- **放弃原因**：{明确说明为什么不用这个方案}

### 方案B：{方案名称}（✅ 选用）
- **描述**：{方案简要说明}
- **优点**：{列出优点}
- **缺点**：{列出缺点}
- **选择原因**：{说明为什么这是最优解}

## 关键设计细节与隐性约束

### 隐性约束1：{约束名称}
- **内容**：{具体约束是什么}
- **原因**：{为什么有这个约束}
- **如果破坏会怎样**：{破坏后的具体后果}

## 被否决的模式/反模式

- ❌ {反模式} —— {为什么禁止}

## 相关测试

- {测试文件路径}: {测试覆盖的约束}

## 变更边界

- {条件触发时，重新评估此决策}
`

/** Build a compound section key preserving heading hierarchy */
function sectionKey(section: string, sub: string): string {
  return sub ? `${section} > ${sub}` : section
}

export class AdrService {
  constructor(private adrRoot: string) {
    if (!existsSync(adrRoot)) {
      mkdirSync(adrRoot, { recursive: true })
    }
  }

  /** The ADR root directory this service is bound to. */
  get root(): string {
    return this.adrRoot
  }

  /** Find the maximum ADR serial number in the directory */
  async findMaxSerial(): Promise<number> {
    let maxSerial = 0
    try {
      const files = await readdir(this.adrRoot)
      for (const file of files) {
        const match = ADR_FILENAME_RE.exec(file)
        if (match) {
          const serial = parseInt(match[1], 10)
          if (serial > maxSerial) maxSerial = serial
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
    return maxSerial
  }

  /** Create a new ADR file */
  async createAdr(params: CreateAdrParams): Promise<{ id: string; filePath: string }> {
    const serial = await this.findMaxSerial() + 1
    const serialStr = String(serial).padStart(4, '0')
    const title = params.title.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
    const adrId = `ADR-${serialStr}-${title}`
    const fileName = `${adrId}.md`
    const filePath = path.join(this.adrRoot, fileName)
    const now = new Date().toISOString()

    const content = params.content || DEFAULT_TEMPLATE
      .replace(/{serial}/g, serialStr)
      .replace(/{title}/g, title)
      .replace(/{created}/g, now)
      .replace(/{requirement}/g, params.requirement ?? '')
      .replace(/{change_type}/g, params.changeType ?? 'new_feature')
      .replace(/{supersedes}/g, params.supersedes ?? 'null')
      .replace(/{description}/g, `New ADR: ${params.title}`)
      .replace(/{constraints}/g, '')

    // Atomic write via temp file + rename to prevent partial writes on crash
    const tmpPath = `${filePath}.tmp`
    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, filePath)
    return { id: adrId, filePath }
  }

  /** Update an existing ADR file */
  async updateAdr(adrId: string, params: UpdateAdrParams): Promise<{ id: string; filePath: string }> {
    const filePath = await this.findAdrFile(adrId)
    if (!filePath) throw new Error(`ADR not found: ${adrId}`)

    let content = await readFile(filePath, 'utf-8')

    if (params.content) {
      if (params.merge) {
        // Replace body only, keep frontmatter
        const fmEnd = content.indexOf('---', 3) + 3
        content = content.slice(0, fmEnd) + '\n' + params.content
      } else {
        content = params.content
      }
    }

    // Update status in frontmatter if requested
    if (params.status) {
      if (!ADR_STATUSES.has(params.status)) {
        throw new Error(`Invalid ADR status: ${params.status}. Valid statuses: active, superseded, deprecated`)
      }
      content = content.replace(
        /^status: .+/m,
        `status: ${params.status}`,
      )
    }
    if (params.supersededBy) {
      content = content.replace(
        /^superseded_by: .+/m,
        `superseded_by: ${params.supersededBy}`,
      )
    }

    // Update timestamp
    const now = new Date().toISOString()
    content = content.replace(
      /^updated: .+/m,
      `updated: ${now}`,
    )

    // Atomic write via temp file + rename to prevent partial writes on crash
    const tmpPath = `${filePath}.tmp`
    await writeFile(tmpPath, content, 'utf-8')
    await rename(tmpPath, filePath)
    return { id: adrId, filePath }
  }

  /** List ADR files with optional filters */
  async listAdrs(filter?: AdrFilter): Promise<AdrListItem[]> {
    const files = await this.getAllAdrFiles()
    const items: AdrListItem[] = []

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      if (!fm) continue

      // Apply status filter
      if (filter?.status && filter.status !== 'all' && fm.status !== filter.status) continue
      // Apply changeType filter
      if (filter?.changeType && fm.trigger.change_type !== filter.changeType) continue

      // Extract summary from first section
      const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
      const summary = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 100) || ''

      items.push({
        id: fm.id,
        filePath,
        status: fm.status,
        created: fm.created,
        updated: fm.updated,
        anchorCount: fm.code_anchors.length,
        summary,
        changeType: fm.trigger.change_type,
      })

      if (filter?.limit && items.length >= filter.limit) break
    }

    return items
  }

  /** Load a full ADR document */
  async loadAdr(adrId: string): Promise<AdrDocument | null> {
    const filePath = await this.findAdrFile(adrId)
    if (!filePath) return null

    const content = await readFile(filePath, 'utf-8')
    const fm = parseFrontmatter(content)
    if (!fm) return null

    // Parse sections — handle both ## headings and ### sub-headings.
    // Sub-headings are keyed as "parent > sub" to preserve hierarchy.
    const sections: Record<string, string> = {}
    const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
    let currentSection = 'body'
    let currentSub = ''
    let currentLines: string[] = []
    for (const line of body.split('\n')) {
      const h2Match = line.match(/^## (.+)/)
      const h3Match = line.match(/^### (.+)/)
      if (h2Match) {
        if (currentLines.length > 0) {
          sections[sectionKey(currentSection, currentSub)] = currentLines.join('\n').trim()
        }
        currentSection = h2Match[1].trim()
        currentSub = ''
        currentLines = []
      } else if (h3Match) {
        if (currentLines.length > 0) {
          sections[sectionKey(currentSection, currentSub)] = currentLines.join('\n').trim()
        }
        currentSub = h3Match[1].trim()
        currentLines = []
      } else {
        currentLines.push(line)
      }
    }
    if (currentLines.length > 0) {
      sections[sectionKey(currentSection, currentSub)] = currentLines.join('\n').trim()
    }

    return { frontmatter: fm, sections, rawContent: content, filePath }
  }

  /** Get all active ADR constraints */
  async getActiveConstraints(): Promise<ConstraintSummary[]> {
    const files = await this.getAllAdrFiles()
    const summaries: ConstraintSummary[] = []

    for (const filePath of files) {
      const content = await readFile(filePath, 'utf-8')
      const fm = parseFrontmatter(content)
      if (!fm || fm.status !== 'active') continue

      // Parse body for constraints sections
      const body = content.replace(/^---[\s\S]*?---\n?/, '').trim()
      const sections = body.split('\n## ')
      let constraints: string[] = []
      let hiddenConstraints: Array<{ name: string; content: string; consequence: string }> = []
      let rejectedPatterns: string[] = []

      for (const section of sections) {
        if (section.startsWith('约束条件')) {
          constraints = section.split('\n')
            .filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'))
            .map(l => l.replace(/^[-*]\s*/, '').replace(/\(来源:.*?\)/, '').trim())
            .filter(Boolean)
        }
        if (section.startsWith('关键设计细节与隐性约束')) {
          // Parse hidden constraint blocks
          const blocks = section.split('### ')
          for (const block of blocks.slice(1)) {
            const lines = block.split('\n')
            const name = lines[0]?.trim() || ''
            const content = lines.find(l => l.includes('**内容**'))?.replace(/.*\*\*内容\*\*:\s*/, '').trim() || ''
            const consequence = lines.find(l => l.includes('**如果破坏会怎样**'))?.replace(/.*\*\*如果破坏会怎样\*\*:\s*/, '').trim() || ''
            if (name) {
              hiddenConstraints.push({ name, content, consequence })
            }
          }
        }
        if (section.startsWith('被否决的模式/反模式')) {
          rejectedPatterns = section.split('\n')
            .filter(l => l.trim().startsWith('❌'))
            .map(l => l.replace(/^❌\s*/, '').trim())
            .filter(Boolean)
        }
      }

      if (constraints.length > 0 || hiddenConstraints.length > 0 || rejectedPatterns.length > 0) {
        const title = body.split('\n')[0]?.replace(/^#+\s*/, '').slice(0, 80) || fm.id
        summaries.push({
          adrId: fm.id,
          adrTitle: title,
          constraints,
          hiddenConstraints,
          rejectedPatterns,
          status: fm.status,
        })
      }
    }

    return summaries
  }

  /** Get all ADR file paths */
  async getAllAdrFiles(): Promise<string[]> {
    try {
      const files = await readdir(this.adrRoot)
      return files
        .filter(f => ADR_FILENAME_RE.test(f))
        .map(f => path.join(this.adrRoot, f))
        .sort()
    } catch {
      return []
    }
  }

  /** Find an ADR file by id (exact match first, then partial/serial fallback) */
  private async findAdrFile(adrId: string): Promise<string | null> {
    const files = await this.getAllAdrFiles()
    // Exact match: strip .md extension and compare the full basename
    const exact = files.find(f => path.basename(f, '.md') === adrId)
    if (exact) return exact
    // Partial match (serial number fallback)
    return files.find(f => path.basename(f).includes(adrId)) ?? null
  }
}