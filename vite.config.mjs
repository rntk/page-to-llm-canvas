import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Static files / directories to copy verbatim into dist/ after build.
const STATIC_FILES = [
  "manifest.json",
  "background.js",
  "content.js",
  "content.css",
  "popup.html",
  "popup.js",
  "options.html",
  "options.js",
  "modal.html",
];

const STATIC_DIRS = ["worker", "icons"];

function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

function copyExtensionStaticAssets() {
  return {
    name: "copy-extension-static-assets",
    apply: "build",
    closeBundle() {
      const root = __dirname;
      const outDir = path.join(root, "dist");
      for (const file of STATIC_FILES) {
        copyFileIfExists(path.join(root, file), path.join(outDir, file));
      }
      for (const dir of STATIC_DIRS) {
        copyDirRecursive(path.join(root, dir), path.join(outDir, dir));
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyExtensionStaticAssets()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    assetsDir: ".",
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        modal: path.join(__dirname, "src/main.jsx"),
      },
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "[name].js",
        chunkFileNames: "[name].js",
        assetFileNames: (assetInfo) => {
          if (assetInfo.name && assetInfo.name.endsWith(".css")) {
            return "modal.css";
          }
          return "[name][extname]";
        },
      },
    },
  },
});
