import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import SelectionToolbar from './SelectionToolbar.jsx';
import InPageRail from './InPageRail.jsx';
import YouTubeRail from './YouTubeRail.jsx';
import { buildYouTubeRailCards } from './youtubeRailSync.js';
import { guardTrustedUserEvent } from './eventSecurity.js';
import { splitError, retryRecord } from '../utils/errorUtils.js';
import { MSG } from '../../messages.js';
import { resolveColumnOverlaps } from '../topicCards.js';
import {
  moveSelectedEntry,
  removeSelectedEntry,
  selectedBlocksForToolbar,
} from './selectionState.js';
import {
  buildRecordViewIframeSrc,
  canStepUpElement,
  stepUpSelectedEntry,
} from './contentViewLogic.js';
import {
  HIGHLIGHT_NAME,
  supportsHighlightApi,
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
} from '../sentenceHighlight.js';
import {
  topicAccentColor,
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
  computeMaxTopicLevel,
} from './recordTransform.js';
import { buildCssPath } from './cssPath.js';
import { buildHtml } from './selectionHtml.js';
import { getScrollableAncestor, getRailOriginTop, computeCardVerticalBox } from './railGeometry.js';
import {
  fetchRecord,
  findPickedElements,
  assessRecordForRail,
  createLoadToken,
} from './recordFetch.js';
import {
  THEME_KEY,
  THEME_SYSTEM,
  getStoredTheme,
  systemThemeSupported,
  normalizeTheme,
  applyThemeToElement,
} from '../../theme.js';
import {
  HIGHLIGHT_COLOR_KEY,
  DEFAULT_HIGHLIGHT_COLOR,
  getStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
} from '../highlightSettings.js';

// The injected toolbar/rail tokens are scoped to their host elements (not the
// host page's :root), so we tag those elements with the saved preference and
// let content.css flip the palette. The "system" case is handled by CSS, so a
// failed/missing read just falls back to system. Cached at injection so the
// elements can be tagged synchronously on creation (no flash).
let cachedThemePreference = THEME_SYSTEM;
let cachedHighlightColor = DEFAULT_HIGHLIGHT_COLOR;
let storagePreferenceListenerAttached = false;
let mountedContentSurfaceCount = 0;
let preferenceStorageSyncId = 0;

function setCachedThemePreference(stored) {
  cachedThemePreference = normalizeTheme(stored, systemThemeSupported());
}

void getStoredTheme().then((stored) => {
  setCachedThemePreference(stored);
  // A surface opened before this async read resolved was tagged with the
  // default; re-tag it now that the real preference is known.
  refreshMountedContentTheme();
});

function applyContentTheme(el) {
  applyThemeToElement(el, cachedThemePreference);
}

function setCachedHighlightColor(stored) {
  cachedHighlightColor = normalizeHighlightColor(stored);
}

void getStoredHighlightColor().then((stored) => {
  setCachedHighlightColor(stored);
  refreshMountedHighlightColor();
});

function applyContentHighlightColor(el) {
  applyHighlightColorToElement(el, cachedHighlightColor);
}

// Re-tag any already-mounted surfaces. The content script caches the preference
// at injection, so a theme change from the popup/options after the page loaded
// would otherwise be ignored until reload. (OS-level "system" changes are
// handled live by the CSS media query and need no JS.)
function refreshMountedContentTheme() {
  if (selectionToolbar) applyContentTheme(selectionToolbar);
  if (inPageRailController && inPageRailController.railEl) {
    applyContentTheme(inPageRailController.railEl);
  }
}

function refreshMountedHighlightColor() {
  applyHighlightColorToElement(document.documentElement, cachedHighlightColor);
  if (selectionToolbar) applyContentHighlightColor(selectionToolbar);
  if (inPageRailController && inPageRailController.railEl) {
    applyContentHighlightColor(inPageRailController.railEl);
  }
}

function syncPreferenceCacheFromStorage() {
  const syncId = ++preferenceStorageSyncId;
  void getStoredTheme().then((stored) => {
    if (syncId !== preferenceStorageSyncId) return;
    setCachedThemePreference(stored);
    refreshMountedContentTheme();
  });
  void getStoredHighlightColor().then((stored) => {
    if (syncId !== preferenceStorageSyncId) return;
    setCachedHighlightColor(stored);
    refreshMountedHighlightColor();
  });
}

function handlePreferenceStorageChange(changes, areaName) {
  if (areaName !== 'local' || !changes) return;
  const themeChange = changes[THEME_KEY];
  const highlightColorChange = changes[HIGHLIGHT_COLOR_KEY];
  if (!themeChange && !highlightColorChange) return;
  preferenceStorageSyncId += 1;
  if (themeChange) {
    setCachedThemePreference(themeChange.newValue);
    refreshMountedContentTheme();
  }
  if (highlightColorChange) {
    setCachedHighlightColor(highlightColorChange.newValue);
    refreshMountedHighlightColor();
  }
}

function attachPreferenceStorageListener() {
  if (storagePreferenceListenerAttached) return;
  try {
    chrome.storage.onChanged.addListener(handlePreferenceStorageChange);
    storagePreferenceListenerAttached = true;
    syncPreferenceCacheFromStorage();
  } catch (_) {
    /* noop */
  }
}

function detachPreferenceStorageListener() {
  if (!storagePreferenceListenerAttached) return;
  try {
    chrome.storage.onChanged.removeListener(handlePreferenceStorageChange);
  } catch (_) {
    /* noop */
  } finally {
    storagePreferenceListenerAttached = false;
  }
}

function trackMountedContentSurface() {
  mountedContentSurfaceCount += 1;
  attachPreferenceStorageListener();
}

function untrackMountedContentSurface() {
  mountedContentSurfaceCount = Math.max(0, mountedContentSurfaceCount - 1);
  if (mountedContentSurfaceCount === 0) detachPreferenceStorageListener();
}

let selectionToolbar = null;
let selectionToolbarRoot = null;
let selectionToolbarShadowRoot = null;
let selectionMode = false;
let selectedElements = [];
let pickCounter = 0;
let dragSrcIndex = null;
let dragOverIndex = null;
let canvasIframe = null;
let inPageRailController = null;
let isSubmitting = false;
const railLoadingTokenHolder = { current: null };
const IN_PAGE_RAIL_WIDTHS = Object.freeze({
  topics: 260,
  summaries: 340,
});
const IN_PAGE_RAIL_RESERVE_GAP = 16;
const TOOLBAR_SHADOW_STYLES = `
  #pagetollm-toolbar-top {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  button {
    padding: 6px 12px;
    border: 1px solid var(--ink);
    border-radius: 0;
    font-size: 14px;
    font-weight: 700;
    cursor: pointer;
    transition:
      background 0.15s ease,
      color 0.15s ease,
      opacity 0.15s ease;
    white-space: nowrap;
  }

  #pagetollm-pick-btn {
    background: var(--surface);
    color: var(--ink);
  }

  #pagetollm-pick-btn.active {
    background: var(--ink);
    color: var(--surface);
  }

  #pagetollm-submit-btn {
    background: var(--ink);
    color: var(--surface);
  }

  #pagetollm-submit-btn:disabled {
    background: var(--surface);
    color: var(--on-surface-muted);
    border-color: var(--ghost);
    cursor: not-allowed;
  }

  #pagetollm-cancel-btn {
    background: var(--surface);
    color: var(--accent);
    border-color: var(--accent);
    margin-left: auto;
  }

  #pagetollm-cancel-btn:hover:not(:disabled) {
    background: var(--accent);
    color: var(--surface);
  }

  button:hover:not(:disabled, .active, #pagetollm-cancel-btn) {
    background: var(--ink);
    color: var(--surface);
  }

  #pagetollm-block-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  #pagetollm-block-list:empty {
    display: none;
  }

  .pagetollm-block-item {
    display: flex;
    align-items: center;
    gap: 8px;
    background: var(--surface-low);
    border-radius: 0;
    padding: 5px 8px;
    cursor: default;
    user-select: none;
    border: 1px solid var(--ghost);
    transition: border-color 0.1s ease;
  }

  .pagetollm-block-item.pagetollm-drag-over {
    border-color: var(--ink);
  }

  .pagetollm-block-item.pagetollm-dragging {
    opacity: 0.4;
  }

  .pagetollm-drag-handle {
    cursor: grab;
    color: var(--on-surface-muted);
    font-size: 17px;
    flex-shrink: 0;
  }

  .pagetollm-drag-handle:active {
    cursor: grabbing;
  }

  .pagetollm-block-label {
    font-size: 14px;
    font-weight: 600;
    flex: 1;
  }

  .pagetollm-remove-btn {
    background: transparent !important;
    color: var(--on-surface-muted) !important;
    padding: 0 4px !important;
    font-size: 14px !important;
    font-weight: 400 !important;
    border: none !important;
    border-radius: 0 !important;
    line-height: 1;
  }

  .pagetollm-remove-btn:hover:not(:disabled) {
    color: var(--accent) !important;
    background: transparent !important;
  }

  .pagetollm-stepup-btn {
    background: transparent !important;
    color: var(--on-surface-muted) !important;
    padding: 0 4px !important;
    font-size: 15px !important;
    font-weight: 700 !important;
    border: none !important;
    border-radius: 0 !important;
    line-height: 1;
  }

  .pagetollm-stepup-btn:hover:not(:disabled) {
    color: var(--ink) !important;
    background: transparent !important;
  }

  .pagetollm-stepup-btn:disabled {
    opacity: 0.3;
    cursor: not-allowed;
  }
`;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === 'startSelection') {
    showSelectionToolbar();
    sendResponse({ status: 'ready' });
    return true;
  }
  if (message.action === 'openRecordView') {
    const key = message.key;
    const mode = message.mode || 'canvas';
    if (!key) {
      sendResponse({ status: 'error', error: 'missing key' });
      return true;
    }
    handleRecordViewRequest({ key }, mode)
      .then(() => sendResponse({ status: 'ok' }))
      .catch((err) =>
        sendResponse({ status: 'error', error: err && err.message ? err.message : String(err) }),
      );
    return true;
  }
  return true;
});

window.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'pagetollm-close') {
    removeCanvasIframe();
  } else if (data && data.type === 'pagetollm-scroll-to-topic-sentences') {
    removeCanvasIframe();
    void openInPageRail({ key: data.key }, 'topics', {
      sentenceNumbers: data.sentenceNumbers,
      level: data.level,
      topicPath: data.topicPath,
    }).catch((err) => {
      console.error('PageToLLM in-page rail error:', err);
    });
  }
});

// ── Record view actions ───────────────────────────────────────────────────

async function handleRecordViewRequest(rec, mode) {
  if (mode === 'canvas') {
    openCanvasIframe(rec.key);
    return;
  }
  if (mode === 'hierarchy') {
    openHierarchyIframe(rec.key);
    return;
  }
  if (mode === 'youtube') {
    await openYouTubeRail(rec);
    return;
  }
  await openInPageRail(rec, mode);
}

// ── Selection toolbar ─────────────────────────────────────────────────────

function showSelectionToolbar() {
  const replacingToolbar = Boolean(selectionToolbar);
  if (selectionToolbar) {
    selectionToolbarRoot && selectionToolbarRoot.unmount();
    selectionToolbar.remove();
  }

  selectionToolbar = document.createElement('div');
  selectionToolbar.id = 'pagetollm-selection-toolbar';
  applyContentTheme(selectionToolbar);
  applyContentHighlightColor(selectionToolbar);
  selectionToolbarShadowRoot = selectionToolbar.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = TOOLBAR_SHADOW_STYLES;
  selectionToolbarShadowRoot.appendChild(style);
  const toolbarMount = document.createElement('div');
  selectionToolbarShadowRoot.appendChild(toolbarMount);
  document.body.appendChild(selectionToolbar);
  selectionToolbarRoot = createRoot(toolbarMount);
  if (import.meta.env.MODE === 'test') {
    window.__pagetollmTestSelectionToolbarRoot = selectionToolbarShadowRoot;
  }
  if (!replacingToolbar) trackMountedContentSurface();
  renderSelectionToolbar();
}

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
  document.querySelectorAll('.pagetollm-element-highlight').forEach((el) => {
    el.classList.remove('pagetollm-element-highlight');
  });
}

function highlightElement(event) {
  if (!selectionMode) return;
  if (event.target.closest('#pagetollm-selection-toolbar')) return;
  const el = event.target;
  if (el && el !== document.body && el !== document.documentElement) {
    el.classList.add('pagetollm-element-highlight');
  }
}

function unhighlightElement(event) {
  if (!selectionMode) return;
  if (event.target.closest('#pagetollm-selection-toolbar')) return;
  const el = event.target;
  if (el && !selectedElements.some((entry) => entry.el === el)) {
    el.classList.remove('pagetollm-element-highlight');
  }
}

function selectElement(event) {
  if (!selectionMode) return;
  if (event.target.closest('#pagetollm-selection-toolbar')) return;
  if (!guardTrustedUserEvent(event)) return;

  event.preventDefault();
  event.stopPropagation();

  const el = event.target;
  el.classList.add('pagetollm-selected');
  pickCounter += 1;
  selectedElements.push({ el, originalNumber: pickCounter });

  selectionMode = false;
  disableSelection();

  renderSelectionToolbar();
  updateSubmitState();
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
      onCancel={cleanupSelection}
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
  if (entry) {
    entry.el.classList.remove('pagetollm-selected');
  }
  selectedElements = removeSelectedEntry(selectedElements, index);
  pickCounter = selectedElements.length;
  renderSelectionToolbar();
  updateSubmitState();
}

function stepUpBlock(event, index) {
  if (!guardTrustedUserEvent(event)) return;
  const result = stepUpSelectedEntry(selectedElements, index);
  if (result.oldElement === null || result.newElement === null) return;

  result.oldElement.classList.remove('pagetollm-selected');
  result.newElement.classList.add('pagetollm-selected');
  selectedElements = result.entries;
  pickCounter = selectedElements.length;

  // The .pagetollm-selected outline now follows the parent on the page, so the
  // user can see exactly which (larger) block will be captured.
  renderSelectionToolbar();
  updateSubmitState();
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
  updateSubmitState();
}

function onDragEnd(event) {
  if (!guardTrustedUserEvent(event)) return;
  dragSrcIndex = null;
  dragOverIndex = null;
  renderSelectionToolbar();
}

function updateSubmitState() {
  renderSelectionToolbar();
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
  updateSubmitState();

  const sourceUrl = window.location.href;
  const els = selectedElements.map(({ el }) => el);
  const html = buildHtml(els);
  const selectors = els.map(buildCssPath);

  try {
    const response = await chrome.runtime.sendMessage({
      type: MSG.submit,
      html,
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
    isSubmitting = false;
    cleanupSelection();
  }
}

function openRecordIframe(key, view) {
  removeCanvasIframe();
  closeInPageRail();
  const iframe = document.createElement('iframe');
  iframe.id = 'pagetollm-canvas-iframe';
  iframe.src = buildRecordViewIframeSrc((path) => chrome.runtime.getURL(path), key, view);
  iframe.style.cssText =
    'position:fixed;inset:0;width:100vw;min-width:100vw;height:100vh;min-height:100vh;border:0;z-index:2147483647;';
  document.documentElement.appendChild(iframe);
  canvasIframe = iframe;
}

function openCanvasIframe(key) {
  openRecordIframe(key);
}

function openHierarchyIframe(key) {
  openRecordIframe(key, 'hierarchy');
}

function removeCanvasIframe() {
  if (canvasIframe) {
    canvasIframe.remove();
    canvasIframe = null;
  }
  const existing = document.getElementById('pagetollm-canvas-iframe');
  if (existing) existing.remove();
}

function cleanupSelection(event) {
  if (!guardTrustedUserEvent(event)) return;
  if (selectionToolbar) {
    selectionToolbarRoot && selectionToolbarRoot.unmount();
    selectionToolbarRoot = null;
    selectionToolbar.remove();
    selectionToolbar = null;
    selectionToolbarShadowRoot = null;
    untrackMountedContentSurface();
    if (import.meta.env.MODE === 'test') {
      window.__pagetollmTestSelectionToolbarRoot = null;
    }
  }

  selectedElements.forEach(({ el }) => el.classList.remove('pagetollm-selected'));
  selectedElements = [];
  pickCounter = 0;
  dragSrcIndex = null;
  dragOverIndex = null;

  selectionMode = false;
  disableSelection();
}

// ── Shared rail surface ───────────────────────────────────────────────────

/**
 * Create the shared in-page rail surface used by both the scroll-synced rail
 * and the YouTube rail: the `<aside>` host, its themed React root, the mount
 * bookkeeping, and the `inPageRailController` teardown. The two rails differ
 * only in a couple of options captured here.
 *
 * @param {object} opts
 * @param {{ mode: string }} opts.state - Live rail state; `setRailWidthForMode` reads `state.mode`.
 * @param {boolean} [opts.youtube] - Tag the host with `data-youtube` (YouTube rail only).
 * @param {() => void} [opts.onTeardown] - Extra teardown step (e.g. clearing CSS highlights).
 * @returns {{ railEl: HTMLElement, railRoot: import('react-dom/client').Root, setRailWidthForMode: () => void, isClosed: () => boolean }}
 */
function createRailSurface({ state, youtube = false, onTeardown } = {}) {
  const railEl = document.createElement('aside');
  railEl.id = 'pagetollm-in-page-rail';
  railEl.dataset.mode = state.mode;
  if (youtube) railEl.dataset.youtube = 'true';
  applyContentTheme(railEl);
  applyContentHighlightColor(railEl);
  const railRoot = createRoot(railEl);
  let railClosed = false;
  let railSurfaceTracked = false;

  const setRailWidthForMode = () => {
    if (railClosed) return;
    const railWidth = IN_PAGE_RAIL_WIDTHS[state.mode] || IN_PAGE_RAIL_WIDTHS.topics;
    railEl.style.width = `${railWidth}px`;
    document.documentElement.style.setProperty(
      '--pagetollm-rail-reserve',
      `${railWidth + IN_PAGE_RAIL_RESERVE_GAP}px`,
    );
    document.documentElement.style.setProperty('--pagetollm-rail-width', `${railWidth}px`);
  };

  document.documentElement.appendChild(railEl);
  trackMountedContentSurface();
  railSurfaceTracked = true;
  inPageRailController = {
    railEl,
    teardown() {
      railClosed = true;
      railRoot.unmount();
      railEl.remove();
      if (railSurfaceTracked) {
        railSurfaceTracked = false;
        untrackMountedContentSurface();
      }
      if (onTeardown) onTeardown();
      document.body.classList.remove('pagetollm-rail-open');
      document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
      document.documentElement.style.removeProperty('--pagetollm-rail-width');
    },
  };

  // Reserve space on the right side of the page so the rail does not overlap text.
  setRailWidthForMode();
  document.body.classList.add('pagetollm-rail-open');

  return { railEl, railRoot, setRailWidthForMode, isClosed: () => railClosed };
}

// ── In-page rail view ─────────────────────────────────────────────────────

async function openInPageRail(rec, initialMode, options = {}) {
  closeInPageRail();
  removeCanvasIframe();

  const guard = createLoadToken(railLoadingTokenHolder);

  // Always re-fetch to get the latest data even if widget data is stale.
  const fetched = await fetchRecord(rec.key);
  if (guard.isStale()) {
    // A newer rail request has started loading, abort this one!
    return;
  }

  const assessment = assessRecordForRail(fetched);
  if (assessment.kind === 'not_found') {
    alert('PageToLLM: Analysis record not found.');
    return;
  }
  if (assessment.kind === 'error') {
    const { message } = splitError(
      assessment.record.error || 'Unknown error occurred during processing.',
    );
    const retry = confirm(
      `PageToLLM: Processing failed.\n\nError: ${message}\n\nWould you like to retry analyzing this page?`,
    );
    if (retry) {
      try {
        await retryRecord(assessment.record.key, 'InPageRail');
        openCanvasIframe(assessment.record.key);
      } catch (err) {
        alert('Retry failed: ' + (err.message || String(err)));
      }
    }
    return;
  }
  if (assessment.kind === 'needs_attention') {
    const open = confirm(
      'PageToLLM: Some topics could not be summarized after several retries.\n\n' +
        'Open the canvas view to retry or skip them?',
    );
    if (open) {
      openCanvasIframe(assessment.record.key);
    }
    return;
  }
  if (assessment.kind === 'in_progress') {
    alert(
      `PageToLLM: Analysis is currently in progress (status: ${assessment.stage}). Please wait a moment and try again.`,
    );
    return;
  }
  if (assessment.kind === 'no_selectors') {
    const openCanvas = confirm(
      'PageToLLM: This record has no saved selectors.\n\nWould you like to open it in the full canvas view instead?',
    );
    if (openCanvas) {
      openCanvasIframe(assessment.record.key);
    }
    return;
  }
  // assessment.kind === 'ready'
  const record = assessment.record;
  const elements = findPickedElements(record.selectors);
  if (elements.length === 0) {
    const openCanvas = confirm(
      'PageToLLM: Could not locate the original article blocks on this page; the page layout may have changed.\n\nWould you like to open it in the full canvas view instead?',
    );
    if (openCanvas) {
      openCanvasIframe(record.key);
    }
    return;
  }

  const wordEntries = collectWordEntries(elements);
  const sentences = Array.isArray(record.sentences) ? record.sentences : [];
  const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);
  const scrollContainer = getScrollableAncestor(elements);

  const state = {
    mode: initialMode,
    selectedLevel: options && typeof options.level === 'number' ? options.level : 0,
  };

  const maxLevel = computeMaxTopicLevel(record);

  const { railEl, railRoot, setRailWidthForMode, isClosed } = createRailSurface({
    state,
    onTeardown: () => {
      if (supportsHighlightApi()) CSS.highlights.delete(HIGHLIGHT_NAME);
    },
  });

  let railOriginTop = 0;

  // Native CSS Custom Highlight API: highlights are painted from a set of live
  // Ranges registered under HIGHLIGHT_NAME. Unlike per-word spans, a single
  // Range per sentence paints continuously across whitespace and inline tags,
  // so there are no gaps between words.
  const activeSentences = new Set();

  function rebuildHighlight() {
    if (!supportsHighlightApi()) return;
    if (activeSentences.size === 0) {
      CSS.highlights.delete(HIGHLIGHT_NAME);
      return;
    }
    const highlight = new Highlight();
    for (const sNum of activeSentences) {
      const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sNum);
      if (domRange) highlight.add(domRange);
    }
    CSS.highlights.set(HIGHLIGHT_NAME, highlight);
  }

  function clearAllHighlights() {
    activeSentences.clear();
    rebuildHighlight();
  }

  function highlightTopic(sentenceList, on) {
    for (const sNum of sentenceList) {
      if (on) activeSentences.add(sNum);
      else activeSentences.delete(sNum);
    }
    rebuildHighlight();
  }

  function scrollToFirst(sentenceList) {
    if (!sentenceList || !sentenceList.length) return;
    const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceList[0]);
    if (!domRange) return;
    const rect = domRange.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    if (scrollContainer && scrollContainer !== window) {
      const cRect = scrollContainer.getBoundingClientRect();
      const delta = rect.top - cRect.top - scrollContainer.clientHeight / 2;
      scrollContainer.scrollTo({ top: scrollContainer.scrollTop + delta, behavior: 'smooth' });
    } else {
      const targetY = rect.top + window.scrollY - window.innerHeight / 2;
      window.scrollTo({ top: targetY, behavior: 'smooth' });
    }
  }

  function buildRailCards() {
    const isSummary = state.mode === 'summaries';
    const entries = isSummary
      ? buildSummaryEntries(record).entries
      : buildHierarchicalTopicEntries(record, state.selectedLevel);
    const eligible = entries.filter((e) => e.level === state.selectedLevel);

    const cardSpecs = [];
    for (const e of eligible) {
      const allSentences = isSummary ? e.sourceSentences : e.sentences;
      const runs = splitIntoContiguousRuns(allSentences);
      for (const run of runs) {
        const box = computeCardVerticalBox(
          run,
          sentenceRanges,
          wordEntries,
          railOriginTop,
          scrollContainer,
        );
        if (!box) continue;
        const accent = topicAccentColor(e.path, e.level || 0);
        cardSpecs.push({
          ...e,
          id: `${e.path}-${run.join('-')}`,
          sentences: run,
          allSentences,
          box,
          accent,
        });
      }
    }

    // Mirror the canvas hierarchy rail: cards in a column must never overlap.
    // Each card already spans one contiguous sentence run, but a mis-measured
    // run can stretch a card across its neighbours and hide the cards in
    // between. resolveColumnOverlaps clips/pushes them into a clean stack.
    const resolved = resolveColumnOverlaps(
      cardSpecs.map((card) => ({
        key: card.id,
        levelIndex: card.level || 0,
        startSentence: card.sentences[0] ?? 0,
        fullPath: card.path,
        top: card.box.top,
        height: card.box.height,
      })),
    );
    const adjustedById = new Map(resolved.map((card) => [card.key, card]));
    for (const card of cardSpecs) {
      const adjusted = adjustedById.get(card.id);
      if (adjusted) card.box = { top: adjusted.top, height: adjusted.height };
    }
    cardSpecs.sort((a, b) => a.box.top - b.box.top);

    const railHeight = cardSpecs.length
      ? Math.max(...cardSpecs.map((c) => c.box.top + c.box.height)) + 80
      : 200;
    return { cards: cardSpecs, bodyHeight: railHeight };
  }

  const handleSelectMode = (mode) => {
    if (isClosed()) return;
    if (mode === 'canvas') {
      closeInPageRail();
      openCanvasIframe(record.key);
      return;
    }
    if (mode === 'hierarchy') {
      closeInPageRail();
      openHierarchyIframe(record.key);
      return;
    }
    if (state.mode === mode) return;
    state.mode = mode;
    railEl.dataset.mode = state.mode;
    setRailWidthForMode();
    clearAllHighlights();
    renderRail();
  };

  const handleSelectLevel = (level) => {
    if (isClosed()) return;
    if (state.selectedLevel === level) return;
    state.selectedLevel = level;
    clearAllHighlights();
    renderRail();
  };

  const handleHighlightCard = (card, on) => {
    const sentenceList = card.sentences || card.sourceSentences || [];
    highlightTopic(sentenceList, on);
  };

  const handleScrollToCard = (card) => {
    const sentenceList = card.sentences || card.sourceSentences || [];
    scrollToFirst(sentenceList);
  };

  function renderRail({ measureOnly = false } = {}) {
    if (isClosed() || guard.isStale()) return;
    const { cards, bodyHeight } = railOriginTop ? buildRailCards() : { cards: [], bodyHeight: 200 };
    flushSync(() => {
      railRoot.render(
        <InPageRail
          mode={state.mode}
          maxLevel={maxLevel}
          selectedLevel={state.selectedLevel}
          cards={measureOnly ? [] : cards}
          bodyHeight={measureOnly ? 200 : bodyHeight}
          onClose={closeInPageRail}
          onSelectMode={handleSelectMode}
          onSelectLevel={handleSelectLevel}
          onHighlightCard={handleHighlightCard}
          onScrollToCard={handleScrollToCard}
          scrollContainer={scrollContainer}
        />,
      );
    });
  }

  renderRail({ measureOnly: true });
  if (isClosed() || guard.isStale()) return;
  const bodyRect = railEl.querySelector('.pagetollm-rail-body').getBoundingClientRect();
  railOriginTop = getRailOriginTop(bodyRect, scrollContainer);
  renderRail();

  if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
    requestAnimationFrame(() => {
      if (isClosed() || guard.isStale()) return;
      highlightTopic(options.sentenceNumbers, true);
      scrollToFirst(options.sentenceNumbers);
    });
  }
}

// ── YouTube-synced rail ────────────────────────────────────────────────────

// Prefer YouTube's main player element so we don't accidentally bind to a
// hover-preview thumbnail or an ad's <video>. Falls back to any <video> for
// non-standard embeds.
function getYouTubeVideoElement() {
  return document.querySelector('.html5-main-video') || document.querySelector('video');
}

async function openYouTubeRail(rec) {
  closeInPageRail();
  removeCanvasIframe();

  const guard = createLoadToken(railLoadingTokenHolder);
  const record = await fetchRecord(rec.key);
  if (guard.isStale()) return;

  if (!record) {
    alert('PageToLLM: Analysis record not found.');
    return;
  }
  // The YouTube rail never touches the page article DOM, so the scroll rail's
  // selector/element gating does not apply — gate only on what the sync needs:
  // a finished analysis with transcript sentences and at least one topic/summary.
  if (record.status !== 'done') {
    alert(
      `PageToLLM: Analysis is not ready yet (status: ${record.status || 'queued'}). Please wait a moment and try again.`,
    );
    return;
  }
  const sentences = Array.isArray(record.sentences) ? record.sentences : [];
  const hasTopics = Array.isArray(record.topics) && record.topics.length > 0;
  const hasSummaries = record.topic_summary_index && typeof record.topic_summary_index === 'object';
  if (sentences.length === 0 || (!hasTopics && !hasSummaries)) {
    alert('PageToLLM: This analysis has no transcript topics to sync with the video.');
    return;
  }

  const state = { mode: 'topics', selectedLevel: 0 };

  const maxLevel = computeMaxTopicLevel(record);

  const { railEl, railRoot, setRailWidthForMode, isClosed } = createRailSurface({
    state,
    youtube: true,
  });

  const getCurrentTime = () => {
    const video = getYouTubeVideoElement();
    if (!video) return null;
    const time = video.currentTime;
    return Number.isFinite(time) ? time : null;
  };

  const seekTo = (seconds) => {
    const video = getYouTubeVideoElement();
    if (!video || !Number.isFinite(seconds)) return;
    try {
      video.currentTime = Math.max(0, seconds);
      if (typeof video.play === 'function') void video.play().catch(() => {});
    } catch (_) {
      /* seeking can throw on a not-yet-ready media element — ignore */
    }
  };

  const handleSelectMode = (mode) => {
    if (isClosed()) return;
    const next = mode === 'summaries' ? 'summaries' : 'topics';
    if (state.mode === next) return;
    state.mode = next;
    railEl.dataset.mode = state.mode;
    setRailWidthForMode();
    renderRail();
  };

  const handleSelectLevel = (level) => {
    if (isClosed()) return;
    if (state.selectedLevel === level) return;
    state.selectedLevel = level;
    renderRail();
  };

  function renderRail() {
    if (isClosed() || guard.isStale()) return;
    const cards = buildYouTubeRailCards({
      record,
      mode: state.mode,
      selectedLevel: state.selectedLevel,
    });
    railRoot.render(
      <YouTubeRail
        mode={state.mode}
        maxLevel={maxLevel}
        selectedLevel={state.selectedLevel}
        cards={cards}
        onSelectMode={handleSelectMode}
        onSelectLevel={handleSelectLevel}
        onClose={closeInPageRail}
        getCurrentTime={getCurrentTime}
        onSeek={seekTo}
      />,
    );
  }

  renderRail();
}

function closeInPageRail() {
  railLoadingTokenHolder.current = null;
  if (inPageRailController) {
    try {
      inPageRailController.teardown();
    } catch (_) {
      /* noop */
    }
    inPageRailController = null;
  }
  document.querySelectorAll('#pagetollm-in-page-rail').forEach((railEl) => railEl.remove());
  document.body.classList.remove('pagetollm-rail-open');
  document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
  document.documentElement.style.removeProperty('--pagetollm-rail-width');
}
