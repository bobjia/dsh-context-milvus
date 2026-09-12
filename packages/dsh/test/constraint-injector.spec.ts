// test/constraint-injector.spec.ts
import { jest } from '@jest/globals'
import * as fs from 'node:fs'
import * as path from 'node:path'

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
    const disposer = setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.section).toHaveBeenCalled()
    expect(sectionResult.name).toBe('decision-memory:rules')
    expect(sectionResult.order).toBe(50)
    expect(typeof disposer).toBe('function')
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

  it('registers hooks regardless of adrEnabled (guard moved to caller)', () => {
    resolveConfig.mockReturnValue({ adrEnabled: false })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    expect(ctx.systemPrompt.section).toHaveBeenCalled()
    expect(ctx.on).toHaveBeenCalled()
  })

  it('disposer tears down all registered sections and hooks', () => {
    const sectionDisposer = jest.fn()
    const contextDisposer = jest.fn()
    const preStepDisposer = jest.fn()
    const toolsResultDisposer = jest.fn()

    ctx.systemPrompt.section.mockReturnValue(sectionDisposer)
    ctx.systemPrompt.context.mockReturnValue(contextDisposer)
    ctx.on.mockImplementation((name: string) => {
      if (name === 'agent/pre-step') return preStepDisposer
      if (name === 'tools/result') return toolsResultDisposer
      return undefined
    })

    const disposer = setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    disposer()

    expect(sectionDisposer).toHaveBeenCalledTimes(1)
    expect(contextDisposer).toHaveBeenCalledTimes(1)
    expect(preStepDisposer).toHaveBeenCalledTimes(1)
    expect(toolsResultDisposer).toHaveBeenCalledTimes(1)
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

  it('refreshes constraint cache on pre-step without injecting warnings', async () => {
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

    // No createUserMessage from timer — only from pending file warnings
    expect(mockCreateUserMessage).not.toHaveBeenCalled()

    // Decision is returned unchanged (no messages injected)
    expect(result.messages).toHaveLength(1)
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

  it('does not refresh constraint cache when reinjectEvery is 0 (default)', async () => {
    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 0,  // default — disabled
      adrSystemPrompt: '',
    })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const preStepHook = getPreStepHook()

    const decision = { kind: 'normal', messages: [] }
    const next = jest.fn().mockResolvedValue(decision)
    const agent = { session: { id: 'session-2' } }

    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    // reinjectEvery=0 → the if (reinjectEvery > 0) guard prevents any refresh
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

  // ── Spec/plan write detection tests ────────────────────────────────────

  it('warns on write to spec path suggesting index_specs', async () => {
    const tempDir = fs.mkdtempSync('constraint-spec-test-')
    const specDir = path.join(tempDir, 'specs')
    const specFile = path.join(specDir, '2026-09-02-my-design.md')
    fs.mkdirSync(specDir, { recursive: true })

    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 0,
      adrSystemPrompt: '',
      specRoot: 'specs',
      planRoot: 'plans',
      indexRoot: tempDir,
    })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const toolsResultHook = getToolsResultHook()
    const preStepHook = getPreStepHook()

    const agent = { session: { id: 'session-spec', header: { cwd: tempDir } } }
    // write tool on a spec file → pending warning for index_specs
    toolsResultHook(
      { agent, name: 'write', arguments: { file_path: specFile } },
      { isError: false },
    )

    const decision = { kind: 'normal', messages: [{ role: 'user', content: 'x' }] }
    const next = jest.fn().mockResolvedValue(decision)
    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    expect(mockCreateUserMessage).toHaveBeenCalledTimes(1)
    const callArg = mockCreateUserMessage.mock.calls[0][0]
    expect(callArg.content[0].text).toContain('检测到新的规格文档')
    expect(callArg.content[0].text).toContain('index_specs')
    expect(result.messages).toHaveLength(2)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('warns on write to plan path suggesting index_specs', async () => {
    const tempDir = fs.mkdtempSync('constraint-plan-test-')
    const planDir = path.join(tempDir, 'plans')
    const planFile = path.join(planDir, '2026-09-02-my-plan.md')
    fs.mkdirSync(planDir, { recursive: true })

    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 0,
      adrSystemPrompt: '',
      specRoot: 'specs',
      planRoot: 'plans',
      indexRoot: tempDir,
    })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const toolsResultHook = getToolsResultHook()
    const preStepHook = getPreStepHook()

    const agent = { session: { id: 'session-plan', header: { cwd: tempDir } } }
    // write tool on a plan file → pending warning for index_specs
    toolsResultHook(
      { agent, name: 'write', arguments: { file_path: planFile } },
      { isError: false },
    )

    const decision = { kind: 'normal', messages: [{ role: 'user', content: 'x' }] }
    const next = jest.fn().mockResolvedValue(decision)
    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    expect(mockCreateUserMessage).toHaveBeenCalledTimes(1)
    const callArg = mockCreateUserMessage.mock.calls[0][0]
    expect(callArg.content[0].text).toContain('检测到新的实现计划文件')
    expect(callArg.content[0].text).toContain('index_specs')
    expect(result.messages).toHaveLength(2)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('does not warn on write to non-spec/plan paths', async () => {
    const tempDir = fs.mkdtempSync('constraint-other-test-')
    const otherFile = path.join(tempDir, 'src', 'lib.ts')
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true })

    // Override anchorIndex to return no ADR matches for this file
    anchorIndex.getAdrsForFile.mockReturnValue([])

    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 0,
      adrSystemPrompt: '',
      specRoot: 'specs',
      planRoot: 'plans',
      indexRoot: tempDir,
    })
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const toolsResultHook = getToolsResultHook()
    const preStepHook = getPreStepHook()

    const agent = { session: { id: 'session-other', header: { cwd: tempDir } } }
    // write tool on a non-spec/plan file → no warning
    toolsResultHook(
      { agent, name: 'write', arguments: { file_path: otherFile } },
      { isError: false },
    )

    const decision = { kind: 'normal', messages: [{ role: 'user', content: 'x' }] }
    const next = jest.fn().mockResolvedValue(decision)
    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    expect(mockCreateUserMessage).not.toHaveBeenCalled()
    expect(result.messages).toHaveLength(1)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('adds both ADR anchor warning and spec warning when file is in both', async () => {
    const tempDir = fs.mkdtempSync('constraint-both-test-')
    const specDir = path.join(tempDir, 'specs')
    const specFile = path.join(specDir, '2026-09-02-my-design.md')
    fs.mkdirSync(specDir, { recursive: true })

    resolveConfig.mockReturnValue({
      adrEnabled: true,
      adrConstraintReinjectEvery: 0,
      adrSystemPrompt: '',
      specRoot: 'specs',
      planRoot: 'plans',
      indexRoot: tempDir,
    })
    // anchorIndex.getAdrsForFile already returns ['ADR-0001'] by default
    setupConstraintInjection(ctx, resolveConfig, adrService, anchorIndex)
    const toolsResultHook = getToolsResultHook()
    const preStepHook = getPreStepHook()

    const agent = { session: { id: 'session-both', header: { cwd: tempDir } } }
    // write tool on a spec file that is also in the anchor index → both warnings
    toolsResultHook(
      { agent, name: 'write', arguments: { file_path: specFile } },
      { isError: false },
    )

    const decision = { kind: 'normal', messages: [{ role: 'user', content: 'x' }] }
    const next = jest.fn().mockResolvedValue(decision)
    const result = await preStepHook({ agent, messages: [], step: {} }, next)

    expect(mockCreateUserMessage).toHaveBeenCalledTimes(1)
    const callArg = mockCreateUserMessage.mock.calls[0][0]
    // Both warnings should be present in the combined message
    expect(callArg.content[0].text).toContain('你修改了文件')
    expect(callArg.content[0].text).toContain('ADR-0001')
    expect(callArg.content[0].text).toContain('检测到新的规格文档')
    expect(callArg.content[0].text).toContain('index_specs')
    expect(result.messages).toHaveLength(2)

    fs.rmSync(tempDir, { recursive: true, force: true })
  })
})