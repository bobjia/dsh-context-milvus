import { z } from 'zod'

const direction = z.enum(['backward', 'forward']).optional()

export const searchCodeSchema = {
  query: z.string().describe('自然语言查询'),
  topK: z.number().int().positive().optional().describe('返回结果数，默认 5'),
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
  pathPrefix: z.string().optional().describe('限定子目录（相对工作区根）'),
}

export const indexCodeSchema = {
  mode: z.enum(['full', 'incremental']).optional().describe('默认 incremental'),
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
}

export const indexStatusSchema = {
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
}

export const findCallersSchema = {
  symbol: z.string().describe('符号名（函数/变量/类）'),
  direction: direction.describe('backward=谁引用我，forward=我引用谁'),
  maxResults: z.number().int().positive().optional(),
  sourceFile: z.string().optional(),
  resolve: z.boolean().optional(),
  path: z.string().optional(),
}

export const traceCallChainSchema = {
  entry: z.string().describe('入口符号名'),
  direction: direction.describe('backward=影响分析，forward=依赖分析'),
  maxDepth: z.number().int().positive().optional(),
  maxResults: z.number().int().positive().optional(),
  resolve: z.boolean().optional(),
  path: z.string().optional(),
}

const adrStatus = z.enum(['active', 'superseded', 'deprecated', 'all']).optional()

export const searchAdrSchema = {
  query: z.string().describe('自然语言查询，如"为什么用了重试队列"'),
  status: adrStatus.describe('过滤状态，默认不过滤'),
  topK: z.number().int().positive().optional().describe('返回结果数，默认 5'),
  pathPrefix: z.string().optional().describe('限定 ADR 子目录（相对工作区根）'),
  path: z.string().optional().describe('工作区根目录，省略则自动发现'),
}

export const searchAdrByFileSchema = {
  filePath: z.string().describe('代码文件路径，相对或绝对'),
  status: adrStatus.describe('过滤状态'),
  path: z.string().optional(),
}

export const listAdrsSchema = {
  status: adrStatus.describe('默认 active'),
  changeType: z.enum(['new_feature', 'refactor', 'bugfix', 'optimization', 'architecture']).optional(),
  limit: z.number().int().positive().optional().describe('默认 100'),
  path: z.string().optional(),
}

export const loadConstraintsSchema = {
  format: z.enum(['summary', 'full']).optional().describe('full 含隐性约束详情，默认 summary'),
  adrIds: z.string().optional().describe('逗号分隔的 ADR id，默认全部 active'),
  path: z.string().optional(),
}

export const createAdrSchema = {
  title: z.string().describe('kebab-case 简短描述，如 webhook-dead-letter-queue'),
  requirement: z.string().optional().describe('触发需求/变更描述'),
  changeType: z.enum(['new_feature', 'refactor', 'bugfix', 'optimization', 'architecture']).optional(),
  supersedes: z.string().optional().describe('被替代的 ADR id'),
  content: z.string().optional().describe('自定义正文，留空则用模板生成'),
  path: z.string().optional(),
}

export const updateAdrSchema = {
  adrId: z.string().describe('ADR id，如 ADR-0001-test'),
  content: z.string().optional().describe('替换正文'),
  status: z.enum(['active', 'superseded', 'deprecated']).optional(),
  supersededBy: z.string().optional().describe('标记被谁替代'),
  merge: z.boolean().optional().describe('true 则合并，保留未传字段'),
  path: z.string().optional(),
}

export const checkAdrConsistencySchema = {
  filePath: z.string().optional().describe('只查这一个文件（相对工作区根）'),
  fix: z.boolean().optional().describe('从 ADR frontmatter 移除失效锚点；默认只报告'),
  path: z.string().optional(),
}

export const indexSpecsSchema = {
  scanPath: z.string().optional().describe('只扫这个目录（相对工作区根）'),
  dryRun: z.boolean().optional().describe('默认 true，只预览不落盘'),
  path: z.string().optional(),
}
