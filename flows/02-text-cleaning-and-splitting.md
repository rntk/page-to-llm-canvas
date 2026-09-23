# Text cleaning and sentence splitting

This is the first processing stage after a record is submitted. The captured page text arrives as literal plain text — the content script already resolved markup, entities, and CSS/layout visibility while the page was live — so this stage normalizes it (whitespace, invisible format characters) rather than parsing it as HTML. The normalized text is split into ordered, one-based source sentences and stored as a checkpoint for later stages and UI highlighting.

If no usable sentences are found, the record is finalized without topic or summary work. Otherwise, the sentence list becomes the shared source coordinate system for topic extraction, summaries, rails, canvas highlights, and chat.

Entrypoint: [`src/core/pipeline/topicRangesStage.js`](../src/core/pipeline/topicRangesStage.js) (normalization: [`src/core/pipeline/capturedText.js`](../src/core/pipeline/capturedText.js))
