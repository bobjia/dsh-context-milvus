import type { Context } from '@deepseek-ai/cordis'

const PROMPT_TEXT = `## 代码检索与关系分析规则

你拥有以下语义检索与代码关系工具：
- search_code：跨文件按语义搜索代码实现（自然语言 query）
- index_code：首次使用前必须先索引代码仓库
- index_status：查看当前代码索引状态
- find_callers：查某个符号被谁引用 / 它引用了谁
- trace_call_chain：BFS 追踪函数调用链（影响分析 / 依赖分析）

### 必须遵守的规则

1. **编码任务开始前**：
   - 先调用 \`index_status\` 检查当前工作区是否已索引
   - 未索引则调用 \`index_code\`（默认增量模式）启动索引
   - 大工作区（>1000 文件）时按工具提示在终端运行备用命令

2. **以下场景必须优先调用 \`search_code\` 而非 grep + read**：
   - 用户描述含 "在哪里"、"怎么实现"、"类似"、"重构"、"定位 bug"、"跨文件理解"
   - 你打算连续 grep + read 超过 2 个文件
   - 任务涉及不熟悉的代码区域、需要快速建立上下文
   - 用户问 "这段代码做了什么"、"为什么这么写" 时，先用 search_code 找相关定义

3. **修改前的影响分析**：
   - 修改函数/类/导出符号前，先用 \`find_callers(symbol=..., direction=backward)\` 查看引用
   - 跨文件场景加 \`sourceFile\` 参数做精确消歧
   - 复杂改动用 \`trace_call_chain\` 追踪多层调用链

4. **禁止行为**：
   - ❌ 跳过 index_code 直接 grep（重复劳动、浪费 token）
   - ❌ 拿到 search_code 空结果就放弃（先确认索引状态、调整 query 措辞）
   - ❌ 用 find_callers 但不传 direction（默认 backward，但 forward 用于依赖分析）`

interface SystemPromptService {
  section(section: { name: string; order: number; text: string }): () => void
}

/**
 * Register the "code-search:rules" system prompt section that nudges the
 * Agent to prefer semantic code search over grep+read across the typical
 * coding-task triggers. Returns a disposer that unregisters the section;
 * callers do not currently invoke it (the prompt is core functionality and
 * is not user-toggleable, unlike the ADR prompt).
 */
export function setupCodeSearchPrompt(ctx: Context): () => void {
  const systemPrompt = ctx.get('systemPrompt') as SystemPromptService | undefined
  if (!systemPrompt?.section) {
    // 早期 DSH 版本可能未挂载 systemPrompt 服务；不抛错，仅跳过。
    return () => {}
  }
  return systemPrompt.section({
    name: 'code-search:rules',
    order: 1480,
    text: PROMPT_TEXT,
  })
}