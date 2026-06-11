import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import SelectionToolbar from './SelectionToolbar.jsx';
import InPageRail from './InPageRail.jsx';
import { guardTrustedUserEvent } from './eventSecurity.js';
import { splitError, retryRecord } from '../utils/errorUtils.js';
import { resolveColumnOverlaps } from '../topicCards.js';
import {
  moveSelectedEntry,
  removeSelectedEntry,
  selectedBlocksForToolbar,
} from './selectionState.js';
import {
  HIGHLIGHT_NAME,
  supportsHighlightApi,
  collectWordEntries,
  buildSentenceDomRange,
  buildSentenceWordRanges,
} from '../sentenceHighlight.js';
import {
  splitPath,
  topicAccentColor,
  buildSummaryEntries,
  buildHierarchicalTopicEntries,
  splitIntoContiguousRuns,
} from './recordTransform.js';
import { buildCssPath, stripHighlightClasses } from './cssPath.js';
import {
  fetchRecord,
  findPickedElements,
  assessRecordForRail,
  createLoadToken,
} from './recordFetch.js';

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
  await openInPageRail(rec, mode);
}

// ── Selection toolbar ─────────────────────────────────────────────────────

function showSelectionToolbar() {
  if (selectionToolbar) {
    selectionToolbarRoot && selectionToolbarRoot.unmount();
    selectionToolbar.remove();
  }

  selectionToolbar = document.createElement('div');
  selectionToolbar.id = 'pagetollm-selection-toolbar';
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
  const selectedBlocks = selectedBlocksForToolbar(selectedElements);

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

function buildHtml(elements) {
  const parts = [];
  for (const el of elements) {
    const clone = el.cloneNode(true);
    stripHighlightClasses(clone);
    parts.push(clone.outerHTML);
  }
  return parts.join('\n');
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
      type: 'submit',
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

function openCanvasIframe(key) {
  removeCanvasIframe();
  closeInPageRail();
  const iframe = document.createElement('iframe');
  iframe.id = 'pagetollm-canvas-iframe';
  iframe.src = chrome.runtime.getURL('modal.html') + '?key=' + encodeURIComponent(key);
  iframe.style.cssText =
    'position:fixed;inset:0;width:100vw;min-width:100vw;height:100vh;min-height:100vh;border:0;z-index:2147483647;';
  document.documentElement.appendChild(iframe);
  canvasIframe = iframe;
}

function openHierarchyIframe(key) {
  removeCanvasIframe();
  closeInPageRail();
  const iframe = document.createElement('iframe');
  iframe.id = 'pagetollm-canvas-iframe';
  iframe.src =
    chrome.runtime.getURL('modal.html') + '?key=' + encodeURIComponent(key) + '&view=hierarchy';
  iframe.style.cssText =
    'position:fixed;inset:0;width:100vw;min-width:100vw;height:100vh;min-height:100vh;border:0;z-index:2147483647;';
  document.documentElement.appendChild(iframe);
  canvasIframe = iframe;
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

// ── In-page rail view ─────────────────────────────────────────────────────

function getScrollableAncestor(elements) {
  const picked = Array.isArray(elements) ? elements.filter(Boolean) : [];
  if (picked.length === 0) return window;

  const containsPickedElements = (candidate) =>
    picked.every((el) => candidate === el || candidate.contains(el));
  const isScrollable = (el) => {
    if (!el || el === document.body || el === document.documentElement) return false;
    const style = window.getComputedStyle(el);
    const overflowY = `${style.overflowY} ${style.overflow}`;
    return /(auto|scroll|overlay)/.test(overflowY) && el.scrollHeight > el.clientHeight + 1;
  };

  let node = picked[0];
  while (node && node !== document.body && node !== document.documentElement) {
    if (isScrollable(node) && containsPickedElements(node)) return node;
    node = node.parentElement;
  }

  return window;
}

function getScrollTop(scrollContainer) {
  return scrollContainer && scrollContainer !== window ? scrollContainer.scrollTop : window.scrollY;
}

function getRailOriginTop(bodyRect, scrollContainer) {
  return scrollContainer && scrollContainer !== window
    ? bodyRect.top
    : bodyRect.top + window.scrollY;
}

function computeCardVerticalBox(
  sentences,
  sentenceRanges,
  wordEntries,
  railOriginTop,
  scrollContainer,
) {
  if (!sentences || sentences.length === 0) return null;
  let top = Infinity,
    bottom = -Infinity;
  const isLaidOut = (rect) => rect && (rect.width > 0 || rect.height > 0);
  const scrollTop = getScrollTop(scrollContainer);
  for (const sNum of sentences) {
    const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sNum);
    if (!domRange) continue;
    // getClientRects() yields one rect per line box the sentence spans, giving
    // a tighter measurement than the start/end corners alone. Skip rects that
    // aren't laid out (display:none etc.) so they don't collapse `top` to 0.
    const rects = Array.from(domRange.getClientRects()).filter(isLaidOut);
    if (rects.length === 0) continue;
    const sTop = Math.min(...rects.map((r) => r.top)) + scrollTop - railOriginTop;
    const sBottom = Math.max(...rects.map((r) => r.bottom)) + scrollTop - railOriginTop;
    if (sTop < top) top = sTop;
    if (sBottom > bottom) bottom = sBottom;
  }
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
  const clampedTop = Math.max(0, top);
  return { top: clampedTop, height: Math.max(40, bottom - clampedTop) };
}

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

  // Calculate maxLevel
  let maxLevel = 0;
  const topics = Array.isArray(record.topics) ? record.topics : [];
  for (const t of topics) {
    const depth = splitPath(t.name).length - 1;
    if (depth > maxLevel) maxLevel = depth;
  }
  const index = record.topic_summary_index;
  if (index && typeof index === 'object') {
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const parts = splitPath(rawPath);
      const level = typeof entry.level === 'number' ? entry.level : parts.length - 1;
      if (level > maxLevel) maxLevel = level;
    }
  }

  const railEl = document.createElement('aside');
  railEl.id = 'pagetollm-in-page-rail';
  railEl.dataset.mode = state.mode;
  const railRoot = createRoot(railEl);
  let railClosed = false;

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
  inPageRailController = {
    railEl,
    teardown() {
      railClosed = true;
      railRoot.unmount();
      railEl.remove();
      if (supportsHighlightApi()) CSS.highlights.delete(HIGHLIGHT_NAME);
      document.body.classList.remove('pagetollm-rail-open');
      document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
      document.documentElement.style.removeProperty('--pagetollm-rail-width');
    },
  };

  // Reserve space on the right side of the page so the rail does not overlap text.
  setRailWidthForMode();
  document.body.classList.add('pagetollm-rail-open');

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
    if (railClosed) return;
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
    if (railClosed) return;
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
    if (railClosed || guard.isStale()) return;
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
  if (railClosed || guard.isStale()) return;
  const bodyRect = railEl.querySelector('.pagetollm-rail-body').getBoundingClientRect();
  railOriginTop = getRailOriginTop(bodyRect, scrollContainer);
  renderRail();

  if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
    requestAnimationFrame(() => {
      if (railClosed || guard.isStale()) return;
      highlightTopic(options.sentenceNumbers, true);
      scrollToFirst(options.sentenceNumbers);
    });
  }
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
