/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vite.config.mjs',
    related: false,
  },
  reporters: ['html', 'clear-text', 'progress', 'json'],
  // Only src/App.jsx and src/main.jsx are excluded here: both are
  // bootstrap/entry files exercised solely by `?raw` source-string tests, so
  // mutating them produces NoCoverage noise rather than signal. Everywhere
  // else, NoCoverage mutants are intentional signal for untested code, not
  // something to be excluded.
  mutate: [
    'src/**/*.{js,jsx,mjs}',
    'worker/**/*.js',
    'background.js',
    'popup.js',
    'theme.js',
    '!src/App.jsx',
    '!src/main.jsx',
    // Test files match the globs above but must never be mutated themselves;
    // exclude them here (not via ignorePatterns, which controls sandbox
    // copying and would strip the test files Stryker needs to run).
    '!**/*.test.{js,jsx,mjs}',
  ],
  ignorePatterns: [
    'dist',
    'coverage',
    '.antigravitycli',
  ],
  coverageAnalysis: 'perTest',
  timeoutMS: 10000,
  ignoreStatic: true,
  // Reuse results for unchanged files so local re-runs are fast.
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  // `break` fails the run below this mutation score; `high`/`low` only colour
  // the report. Baseline established 2026-07-04 at 61.7% (full cold run). `break` is a
  // ratchet: raise it as the score improves, never lower it.
  thresholds: { high: 80, low: 60, break: 55 },
};
