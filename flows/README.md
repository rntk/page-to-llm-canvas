# Extension flows

These notes are short orientation docs for the extension’s main user-facing flows and background pipelines. They describe the responsibility of each flow and point to a code entrypoint for deeper investigation; they are not intended to replace implementation documentation.

## Analysis lifecycle

1. [Selection and submission](./01-selection-and-submission.md) — pick page blocks and create or resubmit an analysis record.
2. [Text cleaning and sentence splitting](./02-text-cleaning-and-splitting.md) — normalize the captured page text into source sentences.
3. [Topic extraction](./03-topic-extraction.md) — ask the LLM for topic ranges and build the topic hierarchy.
4. [Topic summaries](./04-topic-summaries.md) — generate summaries for topic and source ranges, reusing child summaries where a parent run allows it.
5. [Record lifecycle and recovery](./05-record-lifecycle-and-recovery.md) — persist progress, resume, retry, cancel, and surface failures.

## Views and interaction surfaces

6. [In-page rails](./06-in-page-rails.md) — show topic or summary cards alongside the original page.
7. [YouTube rail](./07-youtube-rail.md) — synchronize topic, summary, and chat context with video playback.
8. [Canvas](./08-canvas.md) — explore a saved analysis in the pan/zoom view.
9. [Hierarchy](./09-hierarchy.md) — explore the topic tree as a focused document view.
10. [Article chat](./10-article-chat.md) — ask questions against the selected article/transcript and connect answers to source lines.

## Extension management

11. [Providers, settings, and data management](./11-providers-settings-and-data.md) — configure the active LLM, preferences, diagnostics, and saved data.

The shared runtime message names live in [`src/shared/runtime/messages.js`](../src/shared/runtime/messages.js), and the service-worker composition root that connects the flows is [`src/extension/background/background.js`](../src/extension/background/background.js).
