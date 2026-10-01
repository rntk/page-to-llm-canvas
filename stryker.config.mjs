/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'vitest',
  vitest: {
    configFile: 'vite.config.mjs',
    related: false,
  },
  reporters: ['html', 'clear-text', 'progress', 'json'],
  // Exclude only canvas bootstrap wiring; keep the app in mutation scope.
  mutate: [
    'src/**/*.{js,jsx,mjs}',
    'src/extension/background/background.js',
    'src/extension/popup/popup.js',
    'src/shared/runtime/theme.js',
    'src/shared/runtime/verboseLogSettings.js',
    '!src/canvas/main.jsx',
    // Exclude tests from mutation, but retain them in Stryker's sandbox.
    '!**/*.test.{js,jsx,mjs}',
  ],
  ignorePatterns: ['dist', 'coverage', 'docs', 'icons', '.antigravitycli'],
  coverageAnalysis: 'perTest',
  // Limit concurrent mutation workers.
  concurrency: 4,
  timeoutMS: 10000,
  ignoreStatic: true,
  // Reuse results for unchanged files.
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  // The break threshold fails runs below 60%; raise it as the score improves.
  thresholds: { high: 80, low: 60, break: 60 },
};
