import { build, defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const watch = process.argv.includes('--watch');

const STATIC_FILES = [
  'manifest.json',
  'background.js',
  'messages.js',
  'telemetry.js',
  'verboseLogSettings.js',
  'chat.css',
  'content.css',
  'summary-errors.css',
  'popup.html',
  'options.html',
  'modal.html',
];

const STATIC_DIRS = ['worker', 'icons'];

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
  for (const file of STATIC_FILES) {
    copyFileIfExists(path.join(root, file), path.join(outDir, file));
  }
  for (const dir of STATIC_DIRS) {
    copyDirRecursive(path.join(root, dir), path.join(outDir, dir));
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
      // Disable CSS minification: the default lightningcss minifier warns that
      // the native CSS Custom Highlight API's ::highlight() pseudo-element is
      // unrecognized (it only knows the :highlight pseudo-class), and esbuild
      // isn't available in this rolldown-vite toolchain. The bundled CSS is
      // small, so skipping minification is a fine trade for clean builds.
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

const entries = [
  {
    name: 'content',
    input: path.join(root, 'src/content/main.jsx'),
    emptyOutDir: true,
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
    input: path.join(root, 'popup.js'),
    emptyOutDir: false,
  },
];

for (const entry of entries) {
  await build(configForEntry(entry));
  copyExtensionStaticAssets();
}
