# Providers, settings, and data management

The Options page is the management surface for the active LLM provider, processing preferences, saved records, import/export, diagnostics, and destructive cleanup. Provider settings are validated and stored locally; the pipeline snapshots the active provider at run start so one run uses consistent model and context-window settings.

Preferences such as content-language mode, summary generation, concurrency, theme, highlight color, and verbose logging affect subsequent runs or surfaces according to their scope. Records can be exported/imported, reprocessed, or deleted. Related chats can be revisited or deleted, but are not included in record exports; the data-management controls can remove page data or reset all extension storage.

Entrypoint: [`src/options/OptionsApp.jsx`](../src/options/OptionsApp.jsx)

The `llama_decision` provider connects to llama.cpp's Decision API. Configure a
server root (for example, `http://localhost:8080`) or a URL ending in `/v1`, with
an optional model and bearer token. Sampling temperatures do not apply. Decision
requests return structured answers rather than generated text, so this provider
cannot run the existing summary or chat flows.

When a decision provider is saved, pipeline runs use the first one to place topic
boundaries: it answers split/continue for every gap between adjacent sentences
([`decisionTopicBoundaries.js`](../src/core/pipeline/decisionTopicBoundaries.js)).
The active completion provider then names each resulting range
([`topicRangeLabels.js`](../src/core/pipeline/topicRangeLabels.js)) and writes the
summaries as before. Without a decision provider, the LLM splits topics itself.

Each decision request is recorded in LLM metrics under the `topic_boundaries`
task type (duration, outcome, model, request/response size, and token usage when
the server reports it). Labeling requests are recorded under `topic_labels`. The
record's processing log shows which splitter ran (`pipeline_start`), every failed
or shrunk batch (`topic_boundaries_error`, `topic_boundaries_shrink`), and a run
summary (`topic_boundaries_decided`) with split, near-threshold, request, and
shrink counts. Per-batch progress and labeling requests need verbose logging.

Extension code can use the provider through `createClient(provider).decide(...)`:

```js
import { createClient } from '../src/core/llm/clients.js';
import { choice, noul, score } from '../src/core/llm/decisionClient.js';

const client = createClient({ type: 'llama_decision', url: 'http://localhost:8080' });
const result = await client.decide('The delivered item is broken.', {
  team: choice('Who should handle this?', ['returns', 'billing']),
  replacement: noul('Is a replacement needed?'),
  priority: score('How urgent is this?', ['Routine', 'Soon', 'Urgent']),
});
// result.answers, result.model, and result.usage preserve the server response.
const models = await client.listModels();
```

`decide` accepts `{ model, images, files, signal, metricsCollector }` as its third argument; images
and files must be arrays of data URLs. `listModels` accepts `{ signal }`. Each
request defaults to a 60-second timeout with no automatic retries. Construct
`DecisionClient` directly to customize `timeout` (seconds) or inject a transport.
Changing a custom provider's URL with a blank token clears its previous token.
