module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\\.spec\\.ts$',
  transform: {
    '^.+\\.(t|j)s$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // @stellar/stellar-sdk depends on packages published as ESM only. Jest does
  // not transform node_modules by default, so importing anything that reaches
  // the SDK fails to parse ("Unexpected token 'export'") unless these are
  // explicitly transformed.
  // The negative lookahead scans the rest of the path rather than just the next
  // segment, so nested copies (e.g. stellar-sdk's own @noble/hashes) are
  // matched too.
  transformIgnorePatterns: [
    '/node_modules/(?!.*(@exodus/bytes|@noble/curves|@noble/ed25519|@noble/hashes|eventsource|smol-toml|uint8array-extras)/)',
  ],
  collectCoverageFrom: ['src/**/*.(t|j)s'],
  coverageDirectory: './coverage',
  // Coverage is collected whenever `--coverage` is passed (e.g. `npm test --
  // --coverage`). Thresholds below make the run fail if coverage regresses, so
  // it cannot quietly fall again.
  coverageThreshold: {
    global: {
      lines: 70,
    },
    './src/tokens/': {
      lines: 70,
    },
    './src/stellar/': {
      lines: 70,
    },
    './src/auth/': {
      lines: 70,
    },
  },
  testEnvironment: 'node',
  moduleNameMapper: {
    '^src/(.*)$': '<rootDir>/src/$1',
  },
};