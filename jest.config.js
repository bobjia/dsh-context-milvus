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
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      { useESM: true, tsconfig: '<rootDir>/tsconfig.base.json' },
    ],
  },
}
