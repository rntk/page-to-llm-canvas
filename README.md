# Extension Canvas

Extension Canvas is a Chrome extension for turning parts of a web page into a clearer, easier-to-explore view.

Pick content from any page, open it in a focused canvas, and use summaries and topic hints to understand the page faster. It is meant for reading, reviewing, and making sense of long or complex web content without losing the connection to the original text.

## What it helps with

- Focus on the important parts of a page
- Get a quick summary of selected content
- Explore the main topics in a visual canvas
- Jump between highlighted ideas and the original text
- Reduce clutter while reading online

## How to use it

1. Install the extension in Chrome.
2. Open a web page you want to explore.
3. Select the content you care about.
4. Open the canvas view.
5. Review the summary, topics, and highlighted text.

## Who it is for

Extension Canvas is useful for readers, researchers, students, and anyone who wants to quickly understand web articles, documents, or dense pages.

## Status

This project is currently a proof of concept. Some features may still be experimental or require manual setup.

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
