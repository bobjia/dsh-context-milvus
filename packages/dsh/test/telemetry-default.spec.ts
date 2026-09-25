import { jest } from '@jest/globals'

// The plugin's module graph pulls in @deepseek-ai/dsh-tools, whose transitive
// @deepseek-ai/dsh-scope is not installed in this workspace — stub it like the
// sibling settings-hot-reload.spec.ts (this spec never exercises tool
// argument validation).
jest.unstable_mockModule('@deepseek-ai/dsh-tools', () => ({
  defineTool: (options: any) => ({ ...options, execute: options.execute }),
}))

// Any spec that pulls the core barrel must stub the real Milvus SDK first
// (parquetjs→thrift→uuid is ESM-only and cannot load inside Jest).
jest.unstable_mockModule('@zilliz/milvus2-sdk-node', () => ({
  MilvusClient: class { constructor() {} },
  DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
  MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
  FunctionType: { BM25: 'BM25' },
  RANKER_TYPE: { RRF: 'rrf' },
  ErrorCode: { SUCCESS: 'Success' },
}))

const { getConfig } = await import('dsh-context-milvus-core')
const { Config, readOverrides } = await import('../src/plugins/dsh-context-milvus/index.js')

describe('telemetry defaults (SPEC-2026-09-24-onboarding-activation fix H)', () => {
  test('schema default: telemetryEnabled resolves to true when nothing is configured', () => {
    // Since dsh-settings ≥0.1.7 every field is volatile, so a resolved schema
    // hands back accessors rather than values — read them the way apply() does.
    const parsed = readOverrides(Config({} as any)) as any
    expect(parsed.telemetryEnabled).toBe(true)
  })

  test('schema metadata: the declared default is true', () => {
    expect(Config.dict!.telemetryEnabled.meta.default).toBe(true)
  })

  test('schema metadata: description discloses the default and no-code-content collection', () => {
    const desc = Config.dict!.telemetryEnabled.meta.description as string
    expect(desc).toMatch(/默认开启/)
    expect(desc).toMatch(/不采集代码内容/)
  })

  test('mechanism: schema-resolved defaults flow through getConfig to a real telemetry file', () => {
    // Regression guard: the loader hands the plugin exactly the schema-resolved
    // object (Config({})), and getConfig must turn the schema's '' telemetryFile
    // into the home default — otherwise telemetry silently never writes (the
    // inert-default bug). Goes through the real readOverrides(), so a change to
    // how volatile accessors are unwrapped is caught here rather than at runtime.
    const cfg = getConfig(readOverrides(Config({}) as any))
    expect(cfg.telemetryEnabled).toBe(true)
    expect(cfg.telemetryFile).not.toBe('')
    expect(cfg.telemetryFile).toMatch(/telemetry\.jsonl$/)
  })
})
