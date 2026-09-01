// test/constraint-injector.spec.ts
import { jest } from '@jest/globals'

// Mock dsh-llm — the installed package index pulls in @deepseek-ai/dsh-timeout
// which is not present in this repo's node_modules, so mock the message helper.
const mockCreateUserMessage = jest.fn((input: any) => ({ role: 'user', ...input }))

jest.unstable_mockModule('@deepseek-ai/dsh-llm', () => ({
  createUserMessage: mockCreateUserMessage,
}))

const { setupConstraintInjection } = await import('../src/plugins/dsh-context-milvus/constraint-injector.js')

describe('setupConstraintInjection', () => {
  let ctx: any
  let adrService: any
  let anchorIndex: any
  let resolveConfig: any
  let sectionResult: any
  let contextResult: any

  beforeEach(() => {
    jest.clearAllMocks()
    sectionResult = null
    contextResult = null
    ctx = {
      systemPrompt: {
        section: jest.fn((s: any) => { sectionResult = s }),
        context: jest.fn((c: any) => { contextResult = c }),
      },
      get: jest.fn((key: string) => {
        if (key === 'systemPrompt') return ctx.systemPrompt
        return undefined
      }),
      on: jest.fn(),
    }
    adrService = {
      getActiveConstraints: jest.fn().mockResolvedValue([
        { adrId: 'ADR-0001', adrTitle: 'Test', constraints: ['Must be fast'], rejectedPatterns: ['❌ no X'] },
      ]),
    }
    anchorIndex = {
      getAdrsForFile: jest.fn().mockReturnValue(['ADR-0001']),
    }
    resolveConfig = jest.fn().mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 5,
      adrSystemPrompt: '',
    })
  })

  it('registers a system prompt section', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.section).toHaveBeenCalled()
    expect(sectionResult.name).toBe('decision-memory:rules')
    expect(sectionResult.order).toBe(50)
  })

  it('registers a runtime context provider', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.context).toHaveBeenCalled()
    expect(contextResult.name).toBe('decision-memory:active-constraints')
  })

  it('registers agent/pre-step hook', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.on).toHaveBeenCalledWith('agent/pre-step', expect.any(Function))
  })

  it('registers tools/result hook', () => {
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.on).toHaveBeenCalledWith('tools/result', expect.any(Function))
  })

  it('does nothing when adrEnabled is false', () => {
    resolveConfig.mockReturnValue({ adrEnabled: false })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled()
    expect(ctx.on).not.toHaveBeenCalled()
  })

  // ── Runtime behavior tests ────────────────────────────────────────────

  function getPreStepHook(): any {
    const hook = ctx.on.mock.calls.find((c: any) => c[0] === 'agent/pre-step')?.[1]
    expect(hook).toBeDefined()
    return hook
  }

  function getToolsResultHook(): any {
    const hook = ctx.on.mock.calls.find((c: any) => c[0] === 'tools/result')?.[1]
    expect(hook).toBeDefined()
    return hook
  }

  it('refreshes constraint cache and injects warnings on pre-step', async () => {
    // Re-inject every step so the first call triggers a refresh
    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 1,
      adrSystemPrompt: '',
    })
    const constraints = [
      {
        adrId: 'ADR-0001',
        adrTitle: 'Test Decision',
        constraints: ['Must be fast'],
        hiddenConstraints: [],
        rejectedPatterns: ['no X'],
        status: 'active',
      },
    ]
    adrService.getActiveConstraints.mockResolvedValue(constraints)

    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const preStepHook = getPreStepHook()

    const claimedMessage = { role: 'user', content: 'claimed' }
    const decision = { kind: 'normal', messages: [claimedMessage] }
    const next = jest.fn().mockResolvedValue(decision)
    const agent = { session: { id: 'session-1' } }

    const result = await preStepHook({ agent, messages: [claimedMessage], step: {} }, next)

    // next middleware ran
    expect(next).toHaveBeenCalled()

    // constraint cache was refreshed (short format)
    expect(adrService.getActiveConstraints).toHaveBeenCalled()
    expect(contextResult.text()).toContain('ADR-0001')
    expect(contextResult.text()).toContain('1 约束')

    // warning injected via createUserMessage with the right arguments
    expect(mockCreateUserMessage).toHaveBeenCalledTimes(1)
    const callArg = mockCreateUserMessage.mock.calls[0][0]
    expect(callArg.content[0].text).toContain('约束复查提醒')
    expect(callArg.content[0].text).toContain('ADR-0001')
    expect(callArg.source).toEqual({ kind: 'plugin', plugin: 'dsh-context-milvus' })

    // injected message appears in the returned decision's message list
    expect(result.messages).toHaveLength(2)
    expect(result.messages[1].role).toBe('user')
    expect(result.messages[1].content[0].text).toContain('约束复查提醒')
  })

  it('skips re-injection when the step interval is not reached', async () => {
    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 5,
      adrSystemPrompt: '',
    })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const preStepHook = getPreStepHook()

    const decision = { kind: 'normal', messages: [] }
    const next = jest.fn().mockResolvedValue(decision)
    const agent = { session: { id: 'session-2' } }

    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    // stepCount = 1, 1 % 5 !== 0 → no cache refresh, no warning
    expect(adrService.getActiveConstraints).not.toHaveBeenCalled()
    expect(mockCreateUserMessage).not.toHaveBeenCalled()
    expect(result).toBe(decision)
  })

  it('does not warn on read tool results (I1)', async () => {
    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 0,
      adrSystemPrompt: '',
    })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const toolsResultHook = getToolsResultHook()
    const preStepHook = getPreStepHook()

    const agent = { session: { id: 'session-3' } }
    // read tool on an anchored file → no pending warning
    toolsResultHook(
      { agent, name: 'read', arguments: { file_path: 'src/a.ts' } },
      { isError: false },
    )

    const decision = { kind: 'normal', messages: [{ role: 'user', content: 'x' }] }
    const next = jest.fn().mockResolvedValue(decision)
    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    expect(mockCreateUserMessage).not.toHaveBeenCalled()
    expect(result.messages).toHaveLength(1)
  })

  it('warns on edit tool results for anchored files and injects on pre-step', async () => {
    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 0,
      adrSystemPrompt: '',
    })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const toolsResultHook = getToolsResultHook()
    const preStepHook = getPreStepHook()

    const agent = { session: { id: 'session-4' } }
    // edit tool on an anchored file → pending warning
    toolsResultHook(
      { agent, name: 'edit', arguments: { file_path: 'src/a.ts' } },
      { isError: false },
    )

    const decision = { kind: 'normal', messages: [{ role: 'user', content: 'x' }] }
    const next = jest.fn().mockResolvedValue(decision)
    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    expect(mockCreateUserMessage).toHaveBeenCalledTimes(1)
    const callArg = mockCreateUserMessage.mock.calls[0][0]
    expect(callArg.content[0].text).toContain('你修改了文件')
    expect(callArg.content[0].text).toContain('ADR-0001')
    expect(result.messages).toHaveLength(2)
  })
})