# Selection and submission

The user starts a new analysis from the popup, which asks the content script to open the block-picker toolbar. The picker lets the user select, find, reorder, remove, or move up selected DOM blocks. **Find** scans the current light DOM for likely long-read text and appends its suggested blocks in page order. It keeps the picker open so the user can review every detected block, adjust it, or add manual picks. Find never captures page content, sends a runtime message, submits, or closes the toolbar.

While Find is scanning, the picker stops manual picking and disables selection edits and submission. It reports progress and a short result through the toolbar status region; Cancel remains available and aborts the scan by closing the picker. Existing selections are supplied to the detector and are preserved in their current order. Controller-side filtering also rejects disconnected elements and any detected element that overlaps a selected or already accepted result, so a repeat scan cannot add ancestor, descendant, or duplicate selections.

On submit, the picker serializes the final selected HTML, the rendered text of the selection, and CSS selectors, then sends them to the background service worker. Submit is the only action that sends page content for processing.

The background layer deduplicates by source URL or content hash, creates or resets a queued record, captures the run-level summary preference, and starts processing asynchronously. The picker closes after the submission response; later progress is read from the saved record.

Entrypoint: [`src/content/selection/controller.jsx`](../src/content/selection/controller.jsx)
