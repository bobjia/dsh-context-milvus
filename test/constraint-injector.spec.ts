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
})