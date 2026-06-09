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

- `manifest.json`, `background.js`, `content.js`, `content.css`, `popup.html`, `popup.js`, `options.html`, `options.js`, `icons/`, `worker/`
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

## LLM configuration

The extension supports multiple user-configurable LLM providers, which are stored in the browser's local storage and managed via the Options page.

Supported provider types:

- **OpenAI**: Connects to the official OpenAI API (requires an API key).
- **DeepSeek**: Connects to the official DeepSeek API (requires an API key).
- **Anthropic**: Connects to the official Anthropic API (requires an API key).
- **OpenRouter**: Connects to OpenRouter (requires an API key).
- **OpenAI-compatible (custom URL)**: Connects to a custom URL (e.g., a local server like `http://localhost:8989` or `http://192.168.0.147:8989`) and supports local prompt caching (`cache_prompt`).

Provider cache support is API-specific: OpenAI prompt caching is automatic and uses a stable `prompt_cache_key`; DeepSeek context caching is automatic; Anthropic requests include `cache_control` breakpoints for stable prompt prefixes; local llama.cpp-compatible servers receive `cache_prompt: true`.

Provider service tier support is also API-specific. OpenAI and OpenRouter providers can request `flex` or `priority` service tiers when the selected upstream model supports them. Anthropic does not expose OpenAI-style `flex`; its service tier control maps Priority when available to `service_tier: "auto"` and Standard only to `service_tier: "standard_only"`.

The pipeline uses the designated **active** provider and will not run until at least one provider has been configured and selected as active.
