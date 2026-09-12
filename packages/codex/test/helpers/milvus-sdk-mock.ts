import { jest } from '@jest/globals'

/**
 * Export shape of @zilliz/milvus2-sdk-node used by core's milvus-service.ts.
 *
 * The real SDK cannot be loaded inside Jest's ESM runtime: it pulls in
 * @shanghaikid/parquetjs → thrift → uuid, and uuid is ESM-only, so require()
 * of it throws "Must use import to load ES Module". Any codex spec that
 * imports the core barrel at runtime therefore has to stub the SDK.
 *
 * Specs that need behaviour on specific client methods can override the
 * returned instance, e.g. `MilvusClient: jest.fn(() => ({ insert: ... }))`.
 */
export function milvusSdkMockExports() {
  return {
    MilvusClient: jest.fn(() => ({
      connectPromise: Promise.resolve(),
      hasCollection: jest.fn(async () => true),
      createCollection: jest.fn(async () => ({})),
      createIndex: jest.fn(async () => ({})),
      loadCollectionSync: jest.fn(async () => ({})),
      insert: jest.fn(async () => ({ insertCnt: 0 })),
      delete: jest.fn(async () => ({ deleteCnt: 0 })),
      search: jest.fn(async () => ({ results: [] })),
      query: jest.fn(async () => ({ data: [] })),
    })),
    DataType: { Int64: 5, FloatVector: 101, VarChar: 21, Int32: 4, SparseFloatVector: 104 },
    MetricType: { COSINE: 'COSINE', BM25: 'BM25' },
    FunctionType: { BM25: 'BM25' },
    RANKER_TYPE: { RRF: 'rrf' },
    ErrorCode: { SUCCESS: 'Success' },
  }
}
