/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  inPlace: true,
  testRunner: "vitest",
  vitest: {
    configFile: "vite.config.mjs",
    related: false,
  },
  reporters: ["html", "clear-text", "progress"],
  mutate: [
    "src/**/*.{js,jsx,mjs}",
    "!src/App.jsx",
    "worker/**/*.js",
    "background.js",
    "popup.js",
  ],
  ignorePatterns: [
    "dist",
    "node_modules",
    "coverage",
    ".git",
    ".antigravitycli",
    "**/*.test.{js,jsx,mjs}",
    "**/*.spec.{js,jsx,mjs}",
  ],
  coverageAnalysis: "perTest",
  timeoutMS: 10000,
  ignoreStatic: true,
};
