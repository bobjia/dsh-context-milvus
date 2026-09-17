/** @type {import('ts-jest').JestConfigWithTsJest} */
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  roots: ['<rootDir>/packages'],
  testMatch: ['**/test/**/*.spec.ts'],
  collectCoverageFrom: ['packages/*/src/**/*.ts'],
  moduleNameMapper: {
    '^dsh-context-milvus-core$': '<rootDir>/packages/core/src/index.ts',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    // Jest evaluates tree-sitter once per test file, and the second evaluation
    // corrupts the process-wide native Tree.prototype, silently making chunkCode
    // return zero chunks. Repair the clobbered getter on each load — see
    // packages/core/test/helpers/tree-sitter-jest-repair.cjs.
    '^tree-sitter$': '<rootDir>/packages/core/test/helpers/tree-sitter-jest-repair.cjs',
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, tsconfig: '<rootDir>/tsconfig.base.json' },
    ],
  },
}
