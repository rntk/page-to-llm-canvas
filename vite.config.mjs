import { defineConfig } from 'vite';

// Extension builds are orchestrated by scripts/build-extension.mjs because each
// MV3 entrypoint must be emitted as its own self-contained browser script.
// Keep this file minimal for tools such as Vitest that load Vite config by
// convention; use `npm run build` for production extension output.
export default defineConfig({
  test: {
    restoreMocks: true,
    unstubGlobals: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.stryker-tmp/**',
      '**/.{git,cache,output,temp}/**',
    ],
    setupFiles: ['test/setup.fast-check.mjs'],
    // A real browser's `DOMParser.parseFromString` yields an inert document:
    // an `<iframe src>` in parsed markup is never loaded. Happy DOM instead
    // navigates child frames eagerly, so `sanitizeArticleHtml` (which parses
    // untrusted article HTML before stripping the iframe) kicks off a fetch
    // that outlives the test file and rejects into an already-destroyed
    // AsyncTaskManager. Vitest does not fail the run on it, it just prints a
    // stack next to whichever unrelated file happened to be running. Match
    // real DOMParser semantics instead of chasing the noise.
    environmentOptions: {
      happyDOM: {
        settings: {
          navigation: { disableChildFrameNavigation: true },
        },
      },
    },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'json-summary'],
      include: ['src/**/*.{js,jsx,ts,tsx,mjs}'],
      exclude: ['**/*.test.{js,jsx,ts,tsx,mjs}', '**/*.spec.{js,jsx,ts,tsx,mjs}', 'dist/**'],
      // Ratchet floors. `test:coverage` fails if global coverage drops below
      // these, preventing silent regressions. Raise them as coverage improves
      // (e.g. once the React UI files under src/components and src/content gain
      // behavioural tests). Do not lower them.
      thresholds: {
        lines: 90,
        statements: 87,
        functions: 90,
        branches: 77,
      },
    },
  },
});
