# Extension Canvas

Extension Canvas is a Chrome extension that picks a block of a web page, sends it to an LLM you configure, and shows the resulting topics and summaries in a few different views.

A documentation site with screenshots and screencasts is available at https://rntk.github.io/page-to-llm-canvas/.

Select content from any page, then review its topics, summaries, and highlighted sentences without losing the connection to the original text.

## What it does

- Extracts topics and subtopics from selected page content
- Writes a summary for each topic
- Shows the results as inline tags, a topic hierarchy, or a pan/zoom canvas
- For YouTube videos, opens a sidebar that follows video playback and shows the topic/summary for the current timestamp
- Lets you reprocess or delete a saved analysis from the popup, or stop an in-progress one from the Options page; topics whose summaries keep failing get a "needs attention" state with a retry/skip option in the canvas view
- Shows processing progress on the toolbar icon (progress bar and badge count)
- Supports keyboard navigation on the canvas (arrow keys pan, Home/End/PageUp/PageDown jump between cards)
- Has light, dark, and system themes for the popup and options page

## How to use it

1. Install the extension in Chrome.
2. On the Options page, add an LLM provider and mark it as active (processing will not run without one).
3. Open a web page you want to analyze.
4. Use "Pick Blocks" in the popup to select the content you care about, then submit it.
5. Wait for processing to finish (the toolbar icon shows progress).
6. Open one of the views (inline topics, inline summaries, hierarchy, canvas, or YouTube sync).
7. Review the summary, topics, and highlighted text.

## Who it is for

Extension Canvas is useful for readers, researchers, students, and anyone who wants to understand web articles, documents, or dense pages more quickly.

## Status

This project is currently a proof of concept. Some features may still be experimental or require manual setup.

Build is owned by `scripts/build-extension.mjs`, which runs Vite once per React entrypoint so extension scripts stay self-contained browser files. Produces a `dist/` directory containing:

- `manifest.json`, `background.js`, `content.js`, `content.css`, `popup.html`, `popup.js`, `options.html`, `options.js`, `icons/`, `worker/`
- `modal.html`, `modal.js`, `modal.css` (React bundle)

Source entrypoints:

- `src/content/main.jsx` -> `dist/content.js`
- `src/options/main.jsx` -> `dist/options.js`
- `src/main.jsx` -> `dist/modal.js`

From the repository root, build with Docker (no local Node.js install needed):

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

## Options page

Besides LLM providers, the Options page also lets you:

- Export a saved analysis to a JSON file, and import analyses back in (importing asks for confirmation before overwriting an existing record)
- Turn on "Prefer the language of the content" so topic labels and summaries are written in the content's dominant language instead of English
- Pick the highlight color used for picked blocks and highlighted sentences
- Choose a light, dark, or system theme
