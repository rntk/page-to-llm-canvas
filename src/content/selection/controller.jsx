import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import SelectionToolbar from './SelectionToolbar.jsx';
import { findTextBlocks } from './findTextBlocks.js';
import { MSG } from '../../shared/runtime/messages.js';
import { createSelectedEntry, renumberSelectedEntries } from './state.js';
import { buildCssPath } from './cssPath.js';
import { buildCapture } from './html.js';
import { createSelectionInteraction } from './interaction.js';
import { TOOLBAR_SHADOW_STYLES } from './SelectionToolbar.styles.js';
import { browserRuntimeMessenger } from '../../utils/runtimeMessages.js';
import {
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
} from '../shared/surfacePreferences.js';
import { createLogger } from '../../shared/runtime/log.js';

const log = createLogger();

export function isTrustedUserEvent(
  event,
  { allowSynthetic = import.meta.env.MODE === 'test' } = {},
) {
  if (!event) return true;
  return Boolean(event.isTrusted ?? event.nativeEvent?.isTrusted) || allowSynthetic;
}

export function guardTrustedUserEvent(event, options) {
  if (isTrustedUserEvent(event, options)) return true;
  event.preventDefault?.();
  event.stopPropagation?.();
  return false;
}

const defaultPreferences = {
  applyContentTheme,
  applyContentHighlightColor,
  trackMountedSurface,
  untrackMountedSurface,
  registerThemedSurface,
};
const defaultDialogs = {
  alert: (...args) => globalThis.alert(...args),
};

/** Create and mount one isolated selection session. */
export function createSelectionController({
  document: contentDocument = globalThis.document,
  window: contentWindow = contentDocument?.defaultView ?? globalThis.window,
  rootFactory = createRoot,
  preferences = defaultPreferences,
  runtimeMessenger = browserRuntimeMessenger,
  dialogs = defaultDialogs,
  findBlocks = findTextBlocks,
  onDestroy,
} = {}) {
  if (!contentDocument?.body) return { destroy() {} };

  let selectionToolbar = null;
  let selectionToolbarRoot = null;
  let selectionToolbarShadowRoot = null;
  let findAbortController = null;
  let destroyed = false;
  const document = contentDocument;
  const window = contentWindow;
  const { alert } = { ...defaultDialogs, ...(dialogs ?? {}) };
  const unregisterThemedSurface =
    preferences.registerThemedSurface(() => selectionToolbar) || (() => {});

  const interaction = createSelectionInteraction({
    document,
    guardTrustedUserEvent,
    onChange: renderSelectionToolbar,
  });

  selectionToolbar = document.createElement('div');
  selectionToolbar.id = 'pagetollm-selection-toolbar';
  preferences.applyContentTheme(selectionToolbar);
  preferences.applyContentHighlightColor(selectionToolbar);
  selectionToolbarShadowRoot = selectionToolbar.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = TOOLBAR_SHADOW_STYLES;
  selectionToolbarShadowRoot.appendChild(style);
  const toolbarMount = document.createElement('div');
  selectionToolbarShadowRoot.appendChild(toolbarMount);
  document.body.appendChild(selectionToolbar);
  selectionToolbarRoot = rootFactory(toolbarMount);
  if (import.meta.env.MODE === 'test') {
    window.__pagetollmTestSelectionToolbarRoot = selectionToolbarShadowRoot;
  }
  preferences.trackMountedSurface(contentDocument);
  renderSelectionToolbar();

  function renderSelectionToolbar() {
    if (!selectionToolbarRoot) return;
    const {
      selectionMode,
      isSubmitting,
      isFinding,
      findStatus,
      dragSrcIndex,
      dragOverIndex,
      splittingInstructions,
      summaryInstructions,
    } = interaction.snapshot();

    selectionToolbarRoot.render(
      <SelectionToolbar
        isPicking={selectionMode}
        isSubmitting={isSubmitting}
        isFinding={isFinding}
        status={findStatus}
        selectedBlocks={interaction.toolbarBlocks()}
        draggingIndex={dragSrcIndex}
        dragOverIndex={dragOverIndex}
        splittingInstructions={splittingInstructions}
        summaryInstructions={summaryInstructions}
        onSplittingInstructionsChange={interaction.changeSplittingInstructions}
        onSummaryInstructionsChange={interaction.changeSummaryInstructions}
        onTogglePicking={interaction.toggleSelectionMode}
        onFind={findSelection}
        onSubmit={submitSelection}
        onCancel={handleCancel}
        onRemoveBlock={interaction.removeBlock}
        onStepUpBlock={interaction.stepUpBlock}
        onDragStart={interaction.onDragStart}
        onDragOver={interaction.onDragOver}
        onDrop={interaction.onDrop}
        onDragEnd={interaction.onDragEnd}
      />,
    );
  }

  function hasOverlappingSelection(element, entries) {
    return entries.some(({ el }) => el === element || el.contains(element) || element.contains(el));
  }

  function compareDocumentOrder(a, b) {
    if (a === b) return 0;
    const position = a.compareDocumentPosition(b);
    const following = document.defaultView?.Node?.DOCUMENT_POSITION_FOLLOWING ?? 4;
    return position & following ? -1 : 1;
  }

  function statusForFindResult(status, count) {
    if (status === 'found' && count > 0) {
      return `Found ${count} text block${count === 1 ? '' : 's'}`;
    }
    if (status === 'already-selected') return 'Article text is already selected.';
    if (status === 'incomplete') return 'Finding stopped before completion. Try again.';
    if (status === 'cancelled') return 'Finding cancelled.';
    return 'No clear article found. Try Pick Block.';
  }

  async function findSelection(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || interaction.snapshot().isSubmitting || interaction.snapshot().isFinding)
      return;
    event?.preventDefault?.();
    event?.stopPropagation?.();

    // Stop page picking before the scan and its busy paint.
    interaction.startFind();
    const abortController = new AbortController();
    findAbortController = abortController;
    try {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });
      if (destroyed || abortController.signal.aborted) return;

      const result = await findBlocks(document, {
        selected: interaction.snapshot().selectedElements.map(({ el }) => el),
        signal: abortController.signal,
      });
      if (destroyed || abortController.signal.aborted || findAbortController !== abortController) {
        return;
      }

      let selectedElements = interaction.snapshot().selectedElements;
      const resultBlocks = Array.isArray(result?.blocks) ? result.blocks : [];
      const additions = [];
      let skippedForOverlap = false;
      for (const block of result?.status === 'found' ? resultBlocks : []) {
        const el = block?.element;
        if (
          !el ||
          el.ownerDocument !== document ||
          !el.isConnected ||
          el === document.body ||
          el === document.documentElement
        ) {
          continue;
        }
        if (
          hasOverlappingSelection(el, selectedElements) ||
          hasOverlappingSelection(el, additions)
        ) {
          skippedForOverlap = true;
          continue;
        }
        additions.push(createSelectedEntry(el));
      }
      additions.sort((a, b) => compareDocumentOrder(a.el, b.el));

      if (additions.length > 0) {
        selectedElements = renumberSelectedEntries([...selectedElements, ...additions], {
          mutate: false,
        });
      }

      const resultStatus =
        additions.length > 0
          ? 'found'
          : result?.status === 'found' && skippedForOverlap
            ? 'already-selected'
            : result?.status;
      interaction.finishFind(selectedElements, statusForFindResult(resultStatus, additions.length));
    } catch (err) {
      if (!abortController.signal.aborted && !destroyed) {
        log.error('find text blocks error:', err);
        interaction.finishFind(
          interaction.snapshot().selectedElements,
          'No clear article found. Try Pick Block.',
        );
      }
    } finally {
      if (!destroyed && findAbortController === abortController) {
        findAbortController = null;
      }
    }
  }

  async function submitSelection(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    const {
      selectedElements,
      isSubmitting,
      isFinding,
      splittingInstructions,
      summaryInstructions,
    } = interaction.snapshot();
    if (destroyed || isSubmitting || isFinding) return;
    if (selectedElements.length === 0) {
      alert('Please pick at least one block first.');
      return;
    }

    let succeeded = false;
    flushSync(() => interaction.setSubmitting(true));

    try {
      // A timer alone can run before the next paint. Schedule it from a frame
      // so the committed busy state can paint before costly HTML capture.
      await new Promise((resolve) => {
        window.requestAnimationFrame(() => {
          window.setTimeout(resolve, 0);
        });
      });
      if (destroyed) return;

      const sourceUrl = window.location.href;
      const els = selectedElements.map(({ el }) => el);
      const capture = buildCapture(els, window);
      const selectors = capture.elements.map(buildCssPath);
      const response = await runtimeMessenger.send({
        type: MSG.submit,
        html: capture.html,
        capturedText: capture.capturedText,
        captureVersion: capture.captureVersion,
        sourceUrl,
        selectors,
        splittingInstructions: splittingInstructions.trim(),
        summaryInstructions: summaryInstructions.trim(),
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Submission failed');
      }
      succeeded = true;
    } catch (err) {
      log.error('submit error:', err);
      alert('PageToLLM error: ' + err.message);
    } finally {
      // Keep the selection and typed instructions on failure so the user can retry.
      if (succeeded) destroy();
      else if (!destroyed) interaction.setSubmitting(false);
    }
  }

  function handleCancel(event) {
    if (!guardTrustedUserEvent(event)) return;
    destroy();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    findAbortController?.abort();
    findAbortController = null;
    if (selectionToolbar) {
      selectionToolbarRoot && selectionToolbarRoot.unmount();
      selectionToolbarRoot = null;
      selectionToolbar.remove();
      selectionToolbar = null;
      selectionToolbarShadowRoot = null;
      preferences.untrackMountedSurface();
      if (import.meta.env.MODE === 'test') {
        window.__pagetollmTestSelectionToolbarRoot = null;
      }
    }

    interaction.destroy();
    unregisterThemedSurface();
    onDestroy?.();
  }

  return { destroy };
}
