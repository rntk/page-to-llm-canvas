# Extension Canvas

Chrome MV3 extension that lets you pick blocks of HTML on any page, summarize them, and explore topic structure in an in-page canvas.

## Build

Build is owned by `scripts/build-extension.mjs`, which runs Vite once per React entrypoint so extension scripts stay self-contained browser files. Produces a `dist/` directory containing:

- `manifest.json`, `background.js`, `content.js`, `content.css`, `popup.html`, `popup.js`, `options.html`, `options.js`, `icons/`
- `modal.html`, `modal.js`, `modal.css` (React bundle)

Source entrypoints:

- `src/content/main.jsx` -> `dist/content.js`
- `src/options/main.jsx` -> `dist/options.js`
- `src/main.jsx` -> `dist/modal.js`

From the repository root, build with Docker Compose:

```bash
docker run --rm --user "${UID:-1000}:${GID:-1000}" --workdir /app -v "$PWD:/app" node:24-alpine sh -lc "npm ci && npm run build"
```

Or build locally from this directory:

```bash
npm ci
npm run build
```

## Load unpacked

1. Run the build.
2. In Chrome, open `chrome://extensions`.
3. Enable Developer mode.
4. Click "Load unpacked" and pick the `dist/` directory.

## LLM endpoint

Hardcoded for the POC. The orchestrator (background-side) calls:

- Base URL: `http://192.168.0.147:8989`
- Path: `POST /v1/chat/completions` (OpenAI-compatible)
- Default model: `gpt-oss-20B`
- No auth.

See `CONTRACT.md` for the storage and message-protocol contract shared across all parts.
