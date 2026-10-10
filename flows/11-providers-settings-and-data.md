# Providers, settings, and data management

The Options page is the management surface for the active LLM provider, processing preferences, saved records, import/export, diagnostics, and destructive cleanup. Provider settings are validated and stored locally; the pipeline snapshots the active provider at run start so one run uses consistent model and context-window settings.

Preferences such as content-language mode, summary generation, concurrency, theme, highlight color, and verbose logging affect subsequent runs or surfaces according to their scope. Records can be exported/imported, reprocessed, or deleted. Related chats can be revisited or deleted, but are not included in record exports; the data-management controls can remove page data or reset all extension storage.

Entrypoint: [`src/options/OptionsApp.jsx`](../src/options/OptionsApp.jsx)

The `llama_decision` provider connects to llama.cpp's Decision API. Configure a
server root (for example, `http://localhost:8080`) or a URL ending in `/v1`, with
an optional model and bearer token. A token requires an HTTPS URL unless the host
is localhost; this is checked when saving, with the same rule the client enforces.
Sampling temperatures do not apply. Decision requests return structured answers
rather than generated text, so this provider cannot be the active provider.

Saving a decision provider does not enable it. The **Topic splitter** select on the
Options page (stored as `splitterId` next to `activeId`; `null` = Completion LLM)
chooses which decision provider, if any, places topic boundaries. Deleting the
selected provider resets it to Completion LLM. The splitter answers split/continue
for every gap between adjacent sentences
([`decisionTopicBoundaries.js`](../src/core/pipeline/decisionTopicBoundaries.js)).
The active completion provider then names each resulting range
([`topicRangeLabels.js`](../src/core/pipeline/topicRangeLabels.js)) and writes the
summaries as before. With no splitter selected, the LLM splits topics itself.

Each decision request is recorded in LLM metrics under the `topic_boundaries`
task type (duration, outcome, model, request/response size, and token usage when
the server reports it). Labeling requests are recorded under `topic_labels`. LLM
splitting keeps its own `topic_ranges` task type, and manual resplits are recorded
as `topic_resplit` in either mode, so the two splitters never share a bucket. The
**By topic splitter** table in LLM Request Metrics totals each mode's initial
splitting (Completion LLM: `topic_ranges`; Decision API: `topic_boundaries` +
`topic_labels`) for side-by-side comparison. The
record's processing log shows which splitter ran (`pipeline_start`), every failed
or shrunk batch (`topic_boundaries_error`, `topic_boundaries_shrink`), and a run
summary (`topic_boundaries_decided`) with split, near-threshold, request, and
shrink counts. Per-batch progress and labeling requests need verbose logging.

Each decision request times out after 60 seconds and is not retried. A splitter
whose client cannot be constructed (e.g. a legacy invalid URL) fails the run with
a "Topic splitter ... is misconfigured" error.

Changing a custom provider's URL with a blank token clears its previous token.
