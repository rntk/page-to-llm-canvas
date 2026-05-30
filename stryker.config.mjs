/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  inPlace: true,
  testRunner: 'vitest',
  vitest: {
    configFile: 'vite.config.mjs',
    related: false,
  },
  reporters: ['html', 'clear-text', 'progress'],
  // Only mutate files that have behavioural tests. The React UI entry points
  // and components below are currently exercised only by `?raw` source-string
  // tests (or not at all), so mutating them would produce NoCoverage noise and
  // a long, meaningless run. Add them back here as they gain real tests.
  mutate: ['src/**/*.{js,jsx,mjs}', 'worker/**/*.js', 'background.js', 'popup.js', '!src/App.jsx'],
  ignorePatterns: [
    'dist',
    'node_modules',
    'coverage',
    '.git',
    '.antigravitycli',
    '**/*.test.{js,jsx,mjs}',
    '**/*.spec.{js,jsx,mjs}',
  ],
  coverageAnalysis: 'perTest',
  timeoutMS: 10000,
  ignoreStatic: true,
  // Reuse results for unchanged files so local re-runs are fast.
  incremental: true,
  incrementalFile: 'reports/mutation/stryker-incremental.json',
  // `break` fails the run below this mutation score; `high`/`low` only colour
  // the report. Raise `break` once a full-repo baseline is established.
  thresholds: { high: 80, low: 60, break: 40 },
};
