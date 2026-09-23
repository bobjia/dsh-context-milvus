import { jest } from '@jest/globals'
import type { Context } from '@deepseek-ai/cordis'

const sectionMock = jest.fn(() => jest.fn())
const ctxStub = {
  get: jest.fn((key: string) => (key === 'systemPrompt' ? { section: sectionMock } : undefined)),
} as unknown as Context

const { setupCodeSearchPrompt } = await import(
  '../src/plugins/dsh-context-milvus/code-search-prompt.js'
)

describe('setupCodeSearchPrompt', () => {
  beforeEach(() => sectionMock.mockClear())

  test('registers a code-search:rules section at order 1480', () => {
    setupCodeSearchPrompt(ctxStub)
    expect(sectionMock).toHaveBeenCalledTimes(1)
    const arg = sectionMock.mock.calls[0][0]
    expect(arg.name).toBe('code-search:rules')
    expect(arg.order).toBe(1480)
    expect(typeof arg.text).toBe('string')
  })

  test('prompt text mentions all 4 tools', () => {
    setupCodeSearchPrompt(ctxStub)
    const text = sectionMock.mock.calls[0][0].text
    expect(text).toMatch(/search_code/)
    expect(text).toMatch(/index_code/)
    expect(text).toMatch(/index_status/)
    expect(text).toMatch(/find_callers/)
    expect(text).toMatch(/trace_call_chain/)
  })

  test('returned disposer is the section disposer', () => {
    const inner = jest.fn()
    sectionMock.mockReturnValueOnce(inner)
    const disposer = setupCodeSearchPrompt(ctxStub)
    expect(disposer).toBe(inner)
  })

  test('gracefully no-op when systemPrompt service is unavailable', () => {
    const noSp = { get: () => undefined } as unknown as Context
    expect(() => setupCodeSearchPrompt(noSp)).not.toThrow()
  })

  test('gracefully no-op when systemPrompt.section is missing', () => {
    const noSection = { get: () => ({}) } as unknown as Context
    expect(() => setupCodeSearchPrompt(noSection)).not.toThrow()
  })
})