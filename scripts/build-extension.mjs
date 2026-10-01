import { build, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

// Manifest URLs require these assets at the root of dist/.
const STATIC_ASSETS = [
  { source: 'manifest.json', output: 'manifest.json' },
  { source: 'src/extension/styles/chat.css', output: 'chat.css' },
  { source: 'src/extension/styles/content.css', output: 'content.css' },
  { source: 'src/extension/styles/summary-errors.css', output: 'summary-errors.css' },
  { source: 'src/extension/pages/popup.html', output: 'popup.html' },
  { source: 'src/extension/pages/options.html', output: 'options.html' },
  { source: 'src/extension/pages/modal.html', output: 'modal.html' },
];

const STATIC_DIRS = [{ source: 'icons', output: 'icons' }];

function copyFileIfExists(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
}

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === '__tests__' || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) {
      continue;
    }
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
  const outDir = path.join(root, 'dist');
  for (const { source, output } of STATIC_ASSETS) {
    copyFileIfExists(path.join(root, source), path.join(outDir, output));
  }
  for (const { source, output } of STATIC_DIRS) {
    copyDirRecursive(path.join(root, source), path.join(outDir, output));
  }
}

function configForEntry({ name, input, emptyOutDir }) {
  return defineConfig({
    configFile: false,
    root,
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir,
      assetsDir: '.',
      cssCodeSplit: false,
      // Lightning CSS does not recognize the Custom Highlight API's ::highlight().
      cssMinify: false,
      ...(watch ? { watch: {} } : {}),
      rollupOptions: {
        input,
        output: {
          format: 'iife',
          entryFileNames: `${name}.js`,
          chunkFileNames: '[name].js',
          assetFileNames: (assetInfo) => {
            if (assetInfo.name && assetInfo.name.endsWith('.css')) {
              return name === 'modal' ? 'modal.css' : `${name}-bundle.css`;
            }
            return '[name][extname]';
          },
        },
      },
    },
  });
}

function configForContentFeatures() {
  return defineConfig({
    configFile: false,
    root,
    plugins: [react()],
    build: {
      outDir: 'dist',
      emptyOutDir: false,
      assetsDir: '.',
      cssCodeSplit: false,
      cssMinify: false,
      ...(watch ? { watch: {} } : {}),
      rollupOptions: {
        preserveEntrySignatures: 'strict',
        input: {
          'content-selection': path.join(root, 'src/content/lazy/selectionSurface.js'),
          'content-in-page-rail': path.join(root, 'src/content/lazy/inPageRailSurface.js'),
          'content-youtube-rail': path.join(root, 'src/content/lazy/youTubeRailSurface.js'),
          'content-record-frame': path.join(root, 'src/content/lazy/recordFrameSurface.js'),
        },
        output: {
          format: 'es',
          entryFileNames: '[name].js',
          chunkFileNames: 'content-chunks/[name]-[hash].js',
          assetFileNames: 'content-assets/[name]-[hash][extname]',
        },
      },
    },
  });
}

const entries = [
  {
    name: 'content',
    input: path.join(root, 'src/content/main.jsx'),
    emptyOutDir: true,
  },
  {
    name: 'background',
    input: path.join(root, 'src/extension/background/background.js'),
    emptyOutDir: false,
  },
  {
    name: 'modal',
    input: path.join(root, 'src/canvas/main.jsx'),
    emptyOutDir: false,
  },
  {
    name: 'options',
    input: path.join(root, 'src/options/main.jsx'),
    emptyOutDir: false,
  },
  {
    name: 'popup',
    input: path.join(root, 'src/extension/popup/popup.js'),
    emptyOutDir: false,
  },
];

for (const entry of entries) {
  await build(configForEntry(entry));
}

await build(configForContentFeatures());

// Copy after the first build clears dist/ and all entry builds finish.
copyExtensionStaticAssets();
