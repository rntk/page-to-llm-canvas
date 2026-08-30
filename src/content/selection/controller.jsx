import React from 'react';
import { createRoot } from 'react-dom/client';
import SelectionToolbar from './SelectionToolbar.jsx';
import { guardTrustedUserEvent } from './trustedEvents.js';
import { MSG } from '../../shared/runtime/messages.js';
import { moveSelectedEntry, removeSelectedEntry, selectedBlocksForToolbar } from './state.js';
import { canStepUpElement, stepUpSelectedEntry } from './elementTraversal.js';
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
  onDestroy,
} = {}) {
  let selectionToolbar = null;
  let selectionToolbarRoot = null;
  let selectionToolbarShadowRoot = null;
  let selectionMode = false;
  let selectedElements = [];
  let pickCounter = 0;
  let dragSrcIndex = null;
  let dragOverIndex = null;
  let isSubmitting = false;
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
  preferences.trackMountedSurface();
  renderSelectionToolbar();

  function toggleSelectionMode(event) {
    if (!guardTrustedUserEvent(event)) return;
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
    if (!selectionMode) return;
    if (event.target.closest('#pagetollm-selection-toolbar')) return;
    if (!guardTrustedUserEvent(event)) return;

    event.preventDefault();
    event.stopPropagation();

    const el = event.target;
    setElementSelected(el, true);
    pickCounter += 1;
    selectedElements.push({ el, originalNumber: pickCounter });

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
        selectedBlocks={selectedBlocks}
        draggingIndex={dragSrcIndex}
        dragOverIndex={dragOverIndex}
        onTogglePicking={toggleSelectionMode}
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
    const entry = selectedElements[index];
    selectedElements = removeSelectedEntry(selectedElements, index);
    syncSelectedMarker(entry?.el);
    pickCounter = selectedElements.length;
    renderSelectionToolbar();
  }

  function stepUpBlock(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    const result = stepUpSelectedEntry(selectedElements, index);
    if (result.oldElement === null || result.newElement === null) return;

    selectedElements = result.entries;
    syncSelectedMarker(result.oldElement);
    syncSelectedMarker(result.newElement);
    pickCounter = selectedElements.length;

    // The selected outline now follows the parent on the page, so the
    // user can see exactly which (larger) block will be captured.
    renderSelectionToolbar();
  }

  function onDragStart(event, index) {
    if (!guardTrustedUserEvent(event)) return;
    dragSrcIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
    event.currentTarget.classList.add('pagetollm-dragging');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    renderSelectionToolbar();
  }

  function onDragOver(event, index) {
    if (!guardTrustedUserEvent(event)) return;
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
    event.preventDefault();
    const destIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
    if (dragSrcIndex === null || dragSrcIndex === destIndex) return;

    selectedElements = moveSelectedEntry(selectedElements, dragSrcIndex, destIndex);
    dragOverIndex = null;

    renderSelectionToolbar();
  }

  function onDragEnd(event) {
    if (!guardTrustedUserEvent(event)) return;
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

  async function submitSelection(event) {
    if (!guardTrustedUserEvent(event)) return;
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    if (isSubmitting) return;
    if (selectedElements.length === 0) {
      alert('Please pick at least one block first.');
      return;
    }

    isSubmitting = true;
    renderSelectionToolbar();

    const sourceUrl = window.location.href;
    const els = selectedElements.map(({ el }) => el);
    const capture = buildCapture(els, window);
    const selectors = capture.elements.map(buildCssPath);

    try {
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
      console.error('PageToLLM submit error:', err);
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
