import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  {
    ignores: [
      'dist/**',
      'node_modules/**',
      'coverage/**',
      'reports/**',
      '.stryker-tmp/**',
      // Generated API docs include vendored scripts.
      'docs/api/**',
    ],
  },
  js.configs.recommended,
  react.configs.flat.recommended,
  reactHooks.configs.flat.recommended,
  {
    files: ['**/*.{js,jsx,mjs}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: {
        ...globals.browser,
        ...globals.es2021,
        ...globals.webextensions,
        ...globals.jest,
      },
    },
    plugins: {
      jsdoc,
      'react-refresh': reactRefresh,
    },
    settings: {
      react: { version: 'detect' },
    },
    rules: {
      'jsdoc/check-param-names': ['error', { checkDestructured: false }],
      'jsdoc/require-param': ['error', { checkDestructured: false, checkDestructuredRoots: false }],
      'react-refresh/only-export-components': 'warn',
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react-hooks/set-state-in-effect': 'warn',
      'no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Production modules log through the shared logger; tests can spy on console.
    files: ['src/**/*.{js,jsx,mjs}'],
    ignores: ['**/*.test.{js,jsx,mjs}', 'src/shared/runtime/log.js'],
    rules: {
      'no-console': 'error',
    },
  },
  {
    // Apply these safety rules to production code; test mocks use callback adapters.
    files: ['src/**/*.{js,jsx,mjs}'],
    ignores: ['**/*.test.{js,jsx,mjs}'],
    rules: {
      'require-atomic-updates': 'error',
      'no-promise-executor-return': 'error',
    },
  },
  {
    // Test docblocks are excluded from generated API docs.
    files: ['**/*.test.{js,jsx,mjs}'],
    rules: {
      'jsdoc/check-param-names': 'off',
      'jsdoc/require-param': 'off',
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  {
    // Only the background worker imports its pipeline runner.
    files: ['src/**/*.{js,jsx,mjs}'],
    ignores: ['src/extension/background/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/extension/background/pipeline/*'],
              message:
                'Only the background service worker owns the pipeline runner and its runtime. Observe pipeline state via src/core/pipeline/ instead.',
            },
          ],
        },
      ],
    },
  },
  {
    // Keep src/utils/ independent of the topic domain and background pipeline.
    files: ['src/utils/**/*.js'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/extension/background/pipeline/*'],
              message:
                'Only the background service worker owns the pipeline runner and its runtime. Observe pipeline state via src/core/pipeline/ instead.',
            },
            {
              group: ['**/domain/*'],
              message:
                'src/utils/ must stay topic-agnostic. Topic-specific helpers belong in src/domain/ next to topicDomain.js.',
            },
          ],
        },
      ],
    },
  },
];
