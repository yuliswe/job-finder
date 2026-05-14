/** @type {import('ts-jest').JestConfigWithTsJest} */
const jestConfig = {
  testEnvironment: 'node',
  globalSetup: `<rootDir>/tests/test.globalSetup.ts`,
  globalTeardown: `<rootDir>/tests/test.globalTeardown.ts`,
  setupFiles: [`<rootDir>/tests/test.setupBeforeEnv.ts`],
  setupFilesAfterEnv: [
    `<rootDir>/tests/test.setupAfterEnv.ts`, // runs before every test suite
  ],
  transform: {
    '\\.[tj]sx?$': [
      'esbuild-jest-fixed',
      {
        sourcemap: true,
        format: 'cjs',
        target: 'ESNext',
        loaders: {
          '.test.ts': 'tsx',
        },
      },
    ],
  },
  roots: ['<rootDir>'],
  modulePaths: ['./'],
  moduleNameMapper: {
    '#tests/(.*)': `<rootDir>/tests/$1`,
    '#src/(.*)': `<rootDir>/src/$1`,
  },
  transformIgnorePatterns: [],
  modulePathIgnorePatterns: ['dist'],
  testTimeout: 120_000,
  coverageDirectory: '.coverage',
  coverageReporters: ['lcov'],
  maxWorkers: '75%',
  randomize: true,
  forceExit: true,
};

module.exports = jestConfig;
