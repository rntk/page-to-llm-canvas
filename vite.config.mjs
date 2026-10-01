import { defineConfig } from 'vite';

// Vitest loads this config; scripts/build-extension.mjs builds the MV3 entries.
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
    // Match inert DOMParser documents: Happy DOM otherwise loads iframes in
    // article HTML before sanitization removes them.
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
      // Coverage floors: raise them as coverage improves.
      thresholds: {
        lines: 90,
        statements: 87,
        functions: 90,
        branches: 77,
      },
    },
  },
});
