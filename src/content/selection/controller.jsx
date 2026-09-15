import React from 'react';
import { createRoot } from 'react-dom/client';
import SelectionToolbar from './SelectionToolbar.jsx';
import { findTextBlocks } from './findTextBlocks.js';
import { MSG } from '../../shared/runtime/messages.js';
import {
  canStepUpElement,
  moveSelectedEntry,
  renumberSelectedEntries,
  removeSelectedEntry,
  selectedBlocksForToolbar,
  stepUpSelectedEntry,
} from './state.js';
import { buildCssPath } from './cssPath.js';
import { buildCapture } from './html.js';
import {
  HIGHLIGHTED_ELEMENT_SELECTOR,
  isElementSelected,
  setElementHighlighted,
  setElementSelected,
} from './markers.js';
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
  let selectionMode = false;
  let selectedElements = [];
  let pickCounter = 0;
  let dragSrcIndex = null;
  let dragOverIndex = null;
  let isSubmitting = false;
  let isFinding = false;
  let findStatus = '';
  let findAbortController = null;
  let destroyed = false;
  const document = contentDocument;
  const window = contentWindow;
  const { alert } = { ...defaultDialogs, ...(dialogs ?? {}) };
  const unregisterThemedSurface =
    preferences.registerThemedSurface(() => selectionToolbar) || (() => {});

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

  function toggleSelectionMode(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    selectionMode = !selectionMode;
    if (selectionMode) {
      enableSelection();
    } else {
      disableSelection();
    }
    renderSelectionToolbar();
  }

  function enableSelection() {
    document.addEventListener('mouseover', highlightElement);
    document.addEventListener('mouseout', unhighlightElement);
    document.addEventListener('click', selectElement, true);
  }

  function disableSelection() {
    document.removeEventListener('mouseover', highlightElement);
    document.removeEventListener('mouseout', unhighlightElement);
    document.removeEventListener('click', selectElement, true);
    document.querySelectorAll(HIGHLIGHTED_ELEMENT_SELECTOR).forEach((el) => {
      setElementHighlighted(el, false);
    });
  }

  function highlightElement(event) {
    if (!selectionMode) return;
    if (event.target.closest('#pagetollm-selection-toolbar')) return;
    const el = event.target;
    if (el && el !== document.body && el !== document.documentElement) {
      setElementHighlighted(el, true);
    }
  }

  function unhighlightElement(event) {
    if (!selectionMode) return;
    if (event.target.closest('#pagetollm-selection-toolbar')) return;
    const el = event.target;
    if (el && !isElementSelected(el)) {
      setElementHighlighted(el, false);
    }
  }

  function selectElement(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || !selectionMode || isSubmitting || isFinding) return;
    if (event.target.closest('#pagetollm-selection-toolbar')) return;

    event.preventDefault();
    event.stopPropagation();

    const el = event.target;
    setElementSelected(el, true);
    pickCounter += 1;
    selectedElements.push({ el, originalNumber: pickCounter });
    findStatus = '';

    selectionMode = false;
    disableSelection();

    renderSelectionToolbar();
  }

  function renderSelectionToolbar() {
    if (!selectionToolbarRoot) return;
    const selectedBlocks = selectedBlocksForToolbar(selectedElements, canStepUpElement);

    selectionToolbarRoot.render(
      <SelectionToolbar
        isPicking={selectionMode}
        isSubmitting={isSubmitting}
        isFinding={isFinding}
        status={findStatus}
        selectedBlocks={selectedBlocks}
        draggingIndex={dragSrcIndex}
        dragOverIndex={dragOverIndex}
        onTogglePicking={toggleSelectionMode}
        onFind={findSelection}
        onSubmit={submitSelection}
        onCancel={handleCancel}
        onRemoveBlock={removeBlock}
        onStepUpBlock={stepUpBlock}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
      />,
    );
  }

  function removeBlock(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    const entry = selectedElements[index];
    selectedElements = removeSelectedEntry(selectedElements, index);
    syncSelectedMarker(entry?.el);
    pickCounter = selectedElements.length;
    // The scan summary described a list that no longer exists; drop it so the
    // status region does not misreport the count.
    findStatus = '';
    renderSelectionToolbar();
  }

  function stepUpBlock(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    const result = stepUpSelectedEntry(selectedElements, index);
    if (result.oldElement === null || result.newElement === null) return;

    selectedElements = result.entries;
    syncSelectedMarker(result.oldElement);
    syncSelectedMarker(result.newElement);
    pickCounter = selectedElements.length;
    findStatus = '';

    // The selected outline now follows the parent on the page, so the
    // user can see exactly which (larger) block will be captured.
    renderSelectionToolbar();
  }

  function onDragStart(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    dragSrcIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    renderSelectionToolbar();
  }

  function onDragOver(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const nextDragOverIndex = Number.isInteger(index)
      ? index
      : parseInt(event.currentTarget.dataset.index);
    if (dragOverIndex !== nextDragOverIndex) {
      dragOverIndex = nextDragOverIndex;
      renderSelectionToolbar();
    }
  }

  function onDrop(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    event.preventDefault();
    const destIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
    if (dragSrcIndex === null || dragSrcIndex === destIndex) return;

    selectedElements = moveSelectedEntry(selectedElements, dragSrcIndex, destIndex);
    dragOverIndex = null;

    renderSelectionToolbar();
  }

  function onDragEnd(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (destroyed || isSubmitting || isFinding) return;
    dragSrcIndex = null;
    dragOverIndex = null;
    renderSelectionToolbar();
  }

  function syncSelectedMarker(el) {
    if (!el) return;
    setElementSelected(
      el,
      selectedElements.some((entry) => entry.el === el),
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
    if (isSubmitting || isFinding || destroyed) return;
    event?.preventDefault?.();
    event?.stopPropagation?.();

    // A scan and page picking cannot safely overlap: turn off capture listeners
    // and remove their transient outlines before yielding for the busy UI to paint.
    selectionMode = false;
    disableSelection();
    dragSrcIndex = null;
    dragOverIndex = null;
    isFinding = true;
    findStatus = 'Finding text blocks…';
    const abortController = new AbortController();
    findAbortController = abortController;
    renderSelectionToolbar();

    try {
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });
      if (destroyed || abortController.signal.aborted) return;

      const result = await findBlocks(document, {
        selected: selectedElements.map(({ el }) => el),
        signal: abortController.signal,
      });
      if (destroyed || abortController.signal.aborted || findAbortController !== abortController) {
        return;
      }

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
        additions.push({ el });
      }
      additions.sort((a, b) => compareDocumentOrder(a.el, b.el));

      if (additions.length > 0) {
        additions.forEach(({ el }) => setElementSelected(el, true));
        selectedElements = renumberSelectedEntries([...selectedElements, ...additions], {
          mutate: false,
        });
        pickCounter = selectedElements.length;
      }

      const resultStatus =
        additions.length > 0
          ? 'found'
          : result?.status === 'found' && skippedForOverlap
            ? 'already-selected'
            : result?.status;
      findStatus = statusForFindResult(resultStatus, additions.length);
    } catch (err) {
      if (!abortController.signal.aborted && !destroyed) {
        log.error('find text blocks error:', err);
        findStatus = 'No clear article found. Try Pick Block.';
      }
    } finally {
      if (!destroyed && findAbortController === abortController) {
        // This scan owns the active controller; a cancelled or destroyed scan
        // cannot reach this branch, so no later scan can be reset here.
        // eslint-disable-next-line require-atomic-updates
        isFinding = false;
        findAbortController = null;
        renderSelectionToolbar();
      }
    }
  }

  async function submitSelection(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (destroyed || isSubmitting || isFinding) return;
    if (selectedElements.length === 0) {
      alert('Please pick at least one block first.');
      return;
    }

    isSubmitting = true;
    renderSelectionToolbar();

    try {
      // HTML capture can keep the main thread busy on large pages. Continue in a
      // new task so React and the browser can paint the submitting state first.
      await new Promise((resolve) => {
        window.setTimeout(resolve, 0);
      });

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
      });

      if (!response || !response.ok) {
        throw new Error((response && response.error) || 'Submission failed');
      }
    } catch (err) {
      log.error('submit error:', err);
      alert('PageToLLM error: ' + err.message);
    } finally {
      // Unconditional reset, and the `if (isSubmitting) return;` guard above prevents
      // any concurrent invocation from running while this one is in flight, so there
      // is no other writer to race with.
      // eslint-disable-next-line require-atomic-updates
      isSubmitting = false;
      destroy();
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

    selectedElements.forEach(({ el }) => setElementSelected(el, false));
    selectedElements = [];
    pickCounter = 0;
    dragSrcIndex = null;
    dragOverIndex = null;

    selectionMode = false;
    disableSelection();
    unregisterThemedSurface();
    onDestroy?.();
  }

  return { destroy };
}
