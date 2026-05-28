import { defineConfig } from "vite";

// Extension builds are orchestrated by scripts/build-extension.mjs because each
// MV3 entrypoint must be emitted as its own self-contained browser script.
// Keep this file minimal for tools such as Vitest that load Vite config by
// convention; use `npm run build` for production extension output.
export default defineConfig({});
