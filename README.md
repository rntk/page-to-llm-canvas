# PageToLLM Canvas

PageToLLM Canvas is a Chrome extension that picks a block of a web page, sends it to an LLM you configure, and shows the resulting topics and summaries in a few different views.

A documentation site with screenshots and screencasts is available at https://rntk.github.io/page-to-llm-canvas/.

Select content from any page, then review its topics, summaries, and highlighted sentences without losing the connection to the original text.

> **Experimental — provided as is.** This extension is experimental software provided "as is" without any guarantees or warranties of any kind, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, or non-infringement. No guarantees are made regarding correctness, completeness, availability, or suitability for any purpose. Use at your own risk. The authors and contributors accept no responsibility or liability for any issues, data loss, damages, or other consequences arising from its use.

## What it does

- Extracts topics and subtopics from selected page content
- Writes a summary for each topic
- Shows the results as inline tags, a topic hierarchy, or a pan/zoom canvas
- For YouTube videos with an available transcript, opens a sidebar that follows video playback, lets you jump to a topic's timestamp, and shows the topic/summary for the current moment
- Includes article chat for saved pages and transcripts; answers can cite and highlight the source sentences they use
- Saves analyses so work can resume after the extension's background worker restarts; you can reprocess or delete an analysis from the popup, or stop an in-progress one from the Options page
- Keeps completed summaries when an individual topic fails, marking it as "needs attention" so you can retry or skip it from the canvas
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

## Article chat and saved analyses

Open article chat from the canvas or an in-page view to ask questions about a saved page or video transcript. Its answers can include source evidence; select that evidence to highlight the matching text or, for a video, seek to the relevant timestamp.

Analyses are saved in the extension, so you can return to them later. If processing is interrupted, the extension can continue from its saved progress. You can also reprocess an analysis if the page has changed or if you want to use different provider settings. Chats are managed separately from analyses and are not included when you export an analysis.

## YouTube support

YouTube is a special case: analysis uses the transcript shown on the video page, not the video itself. Open the video's transcript, use **Pick Blocks** to select the transcript as the source, and submit it for analysis. When the transcript's timestamps are available, the extension can turn topics and chat evidence into links that seek to the matching moment and can keep the YouTube rail synchronized with playback.

A transcript must be available for the video. The extension does not process video frames or audio directly.

## Load unpacked

1. Run the build.
2. In Chrome, open `chrome://extensions`.
3. Enable Developer mode.
4. Click "Load unpacked" and pick the `dist/` directory.

## LLM configuration

> **Recommended model: GPT-OSS 20B with `medium` reasoning.** Fast and smart enough to process texts with pretty good quality while keeping latency and cost low. Good default choice if you are unsure which model to pick.

The extension supports multiple user-configurable LLM providers, which are stored in the browser's local storage and managed via the Options page.

Supported provider types:

- **OpenAI**: Connects to the official OpenAI API (requires an API key).
- **DeepSeek**: Connects to the official DeepSeek API (requires an API key).
- **Anthropic**: Connects to the official Anthropic API (requires an API key).
- **OpenRouter**: Connects to OpenRouter (requires an API key).
- **OpenAI-compatible (custom URL)**: Connects to a custom URL (e.g., a local server like `http://localhost:8989` or `http://192.168.0.147:8989`) and supports local prompt caching (`cache_prompt`).

Provider cache support is API-specific: OpenAI prompt caching is automatic and uses a stable `prompt_cache_key`; DeepSeek context caching is automatic; Anthropic requests include `cache_control` breakpoints for stable prompt prefixes; local llama.cpp-compatible servers receive `cache_prompt: true`.

Provider service tier support is also API-specific. OpenAI and OpenRouter providers can request `flex` or `priority` service tiers when the selected upstream model supports them. Anthropic does not expose OpenAI-style `flex`; its service tier control maps Priority when available to `service_tier: "auto"` and Standard only to `service_tier: "standard_only"`.

Sampling temperature is configured per provider, with a separate field for each task group: **summaries**, **chat**, and **splitting**. A field left empty means the `temperature` parameter is not sent at all for that task group, so the model's own default applies — the only working setting for models that reject the parameter, such as OpenAI reasoning models, which answer such requests with a non-retryable HTTP 400.

The pipeline uses the designated **active** provider and will not run until at least one provider has been configured and selected as active.
For models with a smaller context window—especially local/custom models—set the optional context-window token count on the provider. Topic and summary inputs are then chunked to a conservative per-request budget derived from that value; providers without one use the 60,000-character fallback.

## Data and privacy

Provider settings, saved analyses, and preferences are stored in the browser's local extension storage. To generate topics, summaries, or chat answers, the extension sends the relevant selected content or transcript to the active provider. Review that provider's data-handling policy before submitting sensitive content.

## Options page

Besides LLM providers, the Options page also lets you:

- Export a saved analysis to a JSON file, and import analyses back in (importing asks for confirmation before overwriting an existing record)
- Reprocess, delete, or stop processing saved analyses; manage or delete saved chat sessions separately
- Turn on "Prefer the language of the content" so topic labels and summaries are written in the content's dominant language instead of English
- Pick the highlight color used for picked blocks and highlighted sentences
- Choose a light, dark, or system theme
