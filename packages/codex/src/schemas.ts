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
