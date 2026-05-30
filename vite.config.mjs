import { defineConfig } from 'vite';

// Extension builds are orchestrated by scripts/build-extension.mjs because each
// MV3 entrypoint must be emitted as its own self-contained browser script.
// Keep this file minimal for tools such as Vitest that load Vite config by
// convention; use `npm run build` for production extension output.
export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', '**/dist/**', '**/.{git,cache,output,temp}/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      include: ['src/**/*.{js,jsx,ts,tsx,mjs}', 'worker/**/*.js', 'background.js', 'popup.js'],
      exclude: ['**/*.test.{js,jsx,ts,tsx,mjs}', '**/*.spec.{js,jsx,ts,tsx,mjs}', 'dist/**'],
      // Ratchet floors. `test:coverage` fails if global coverage drops below
      // these, preventing silent regressions. Raise them as coverage improves
      // (e.g. once the React UI files under src/components and src/content gain
      // behavioural tests). Do not lower them.
      thresholds: {
        lines: 68,
        statements: 66,
        functions: 74,
        branches: 54,
      },
    },
  },
});
