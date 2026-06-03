import React from 'react';
import { flushSync } from 'react-dom';
import { createRoot } from 'react-dom/client';
import SelectionToolbar from './SelectionToolbar.jsx';
import InPageRail from './InPageRail.jsx';

let selectionToolbar = null;
let selectionToolbarRoot = null;
let selectionMode = false;
let selectedElements = [];
let pickCounter = 0;
let dragSrcIndex = null;
let dragOverIndex = null;
let canvasIframe = null;
let inPageRailController = null;
const IN_PAGE_RAIL_WIDTHS = Object.freeze({
  topics: 260,
  summaries: 340,
});
const IN_PAGE_RAIL_RESERVE_GAP = 16;

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
    openInPageRail({ key: data.key }, 'topics', {
      sentenceNumbers: data.sentenceNumbers,
      level: data.level,
      topicPath: data.topicPath,
    });
  }
});

// ── CSS selector path ─────────────────────────────────────────────────────

function buildCssPath(el) {
  if (!(el instanceof Element)) return '';
  const parts = [];
  let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement) {
    let selector = node.nodeName.toLowerCase();
    if (node.id) {
      selector += `#${CSS.escape(node.id)}`;
      parts.unshift(selector);
      break;
    }
    let sib = node,
      nth = 1;
    while ((sib = sib.previousElementSibling)) {
      if (sib.nodeName === node.nodeName) nth++;
    }
    selector += `:nth-of-type(${nth})`;
    parts.unshift(selector);
    node = node.parentElement;
  }
  return parts.join(' > ');
}

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
  selectionToolbar.id = 'rsstag-selection-toolbar';
  document.body.appendChild(selectionToolbar);
  selectionToolbarRoot = createRoot(selectionToolbar);
  renderSelectionToolbar();
}

function toggleSelectionMode() {
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
  document.querySelectorAll('.rsstag-element-highlight').forEach((el) => {
    el.classList.remove('rsstag-element-highlight');
  });
}

function highlightElement(event) {
  if (!selectionMode) return;
  if (event.target.closest('#rsstag-selection-toolbar')) return;
  const el = event.target;
  if (el && el !== document.body && el !== document.documentElement) {
    el.classList.add('rsstag-element-highlight');
  }
}

function unhighlightElement(event) {
  if (!selectionMode) return;
  if (event.target.closest('#rsstag-selection-toolbar')) return;
  const el = event.target;
  if (el && !selectedElements.some((entry) => entry.el === el)) {
    el.classList.remove('rsstag-element-highlight');
  }
}

function selectElement(event) {
  if (!selectionMode) return;
  if (event.target.closest('#rsstag-selection-toolbar')) return;

  event.preventDefault();
  event.stopPropagation();

  const el = event.target;
  el.classList.add('rsstag-selected');
  pickCounter += 1;
  selectedElements.push({ el, originalNumber: pickCounter });

  selectionMode = false;
  disableSelection();

  renderSelectionToolbar();
  updateSubmitState();
}

function renderSelectionToolbar() {
  if (!selectionToolbarRoot) return;
  const selectedBlocks = selectedElements.map((entry) => ({
    id: entry.originalNumber,
    originalNumber: entry.originalNumber,
  }));

  selectionToolbarRoot.render(
    <SelectionToolbar
      isPicking={selectionMode}
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

function removeBlock(index) {
  const entry = selectedElements[index];
  if (entry) {
    entry.el.classList.remove('rsstag-selected');
  }
  selectedElements.splice(index, 1);
  selectedElements.forEach((item, idx) => {
    item.originalNumber = idx + 1;
  });
  pickCounter = selectedElements.length;
  renderSelectionToolbar();
  updateSubmitState();
}

function onDragStart(event, index) {
  dragSrcIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
  event.currentTarget.classList.add('rsstag-dragging');
  event.dataTransfer.effectAllowed = 'move';
  renderSelectionToolbar();
}

function onDragOver(event, index) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  const nextDragOverIndex = Number.isInteger(index)
    ? index
    : parseInt(event.currentTarget.dataset.index);
  if (dragOverIndex !== nextDragOverIndex) {
    dragOverIndex = nextDragOverIndex;
    renderSelectionToolbar();
  }
}

function onDrop(event, index) {
  event.preventDefault();
  const destIndex = Number.isInteger(index) ? index : parseInt(event.currentTarget.dataset.index);
  if (dragSrcIndex === null || dragSrcIndex === destIndex) return;

  const moved = selectedElements.splice(dragSrcIndex, 1)[0];
  selectedElements.splice(destIndex, 0, moved);
  dragOverIndex = null;

  selectedElements.forEach((item, idx) => {
    item.originalNumber = idx + 1;
  });

  renderSelectionToolbar();
  updateSubmitState();
}

function onDragEnd() {
  dragSrcIndex = null;
  dragOverIndex = null;
  renderSelectionToolbar();
}

function buildHtml(elements) {
  const parts = [];
  for (const el of elements) {
    const clone = el.cloneNode(true);
    if (clone.classList) {
      clone.classList.remove('rsstag-selected', 'rsstag-element-highlight');
    }
    clone.querySelectorAll &&
      clone.querySelectorAll('.rsstag-selected, .rsstag-element-highlight').forEach((c) => {
        c.classList.remove('rsstag-selected', 'rsstag-element-highlight');
      });
    parts.push(clone.outerHTML);
  }
  return parts.join('\n');
}

function updateSubmitState() {
  renderSelectionToolbar();
}

async function submitSelection(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  if (selectedElements.length === 0) {
    alert('Please pick at least one block first.');
    return;
  }

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

    openCanvasIframe(response.key);
  } catch (err) {
    console.error('PageToLLM submit error:', err);
    alert('PageToLLM error: ' + err.message);
  } finally {
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

function cleanupSelection() {
  if (selectionToolbar) {
    selectionToolbarRoot && selectionToolbarRoot.unmount();
    selectionToolbarRoot = null;
    selectionToolbar.remove();
    selectionToolbar = null;
  }

  selectedElements.forEach(({ el }) => el.classList.remove('rsstag-selected'));
  selectedElements = [];
  pickCounter = 0;
  dragSrcIndex = null;
  dragOverIndex = null;

  selectionMode = false;
  disableSelection();
}

// ── In-page rail view ─────────────────────────────────────────────────────

const WORD_TOKEN_RE = /\S+/g;
const HIGHLIGHT_NAME = 'pagetollm-sentence';

function supportsHighlightApi() {
  return typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight !== 'undefined';
}

function tokenizeText(text) {
  return String(text || '').match(WORD_TOKEN_RE) || [];
}

function isSkippableContainer(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
  if (node.id === 'pagetollm-in-page-rail') return true;
  return false;
}

/**
 * Walk text nodes within roots and record each word's position WITHOUT mutating
 * the DOM. Returns the global ordered list of word entries:
 * [{ word, node, start, end }] where node/start/end locate the word inside a
 * live text node, suitable for building a Range.
 */
function collectWordEntries(roots) {
  const entries = [];
  const textNodes = [];
  const walker = (root) => {
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        let p = node.parentNode;
        while (p && p !== root.parentNode) {
          if (isSkippableContainer(p)) return NodeFilter.FILTER_REJECT;
          p = p.parentNode;
        }
        if (!node.nodeValue || !node.nodeValue.trim()) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = tw.nextNode())) textNodes.push(n);
  };
  roots.forEach(walker);

  for (const textNode of textNodes) {
    const value = textNode.nodeValue;
    WORD_TOKEN_RE.lastIndex = 0;
    let m;
    while ((m = WORD_TOKEN_RE.exec(value))) {
      entries.push({
        word: m[0],
        node: textNode,
        start: m.index,
        end: m.index + m[0].length,
      });
    }
  }

  return entries;
}

/**
 * Build a live DOM Range spanning from the first word to the last word of a
 * sentence (inclusive). Returns null if the entries are missing.
 */
function buildSentenceDomRange(sentenceRanges, wordEntries, sNum) {
  const range = sentenceRanges.get(sNum);
  if (!range) return null;
  const startEntry = wordEntries[range.startIdx];
  const endEntry = wordEntries[range.endIdx];
  if (!startEntry || !endEntry) return null;
  try {
    const domRange = document.createRange();
    domRange.setStart(startEntry.node, startEntry.start);
    domRange.setEnd(endEntry.node, endEntry.end);
    return domRange;
  } catch (_) {
    return null;
  }
}

/**
 * Map each sentence (1-based) to a [wordStartIndex, wordEndIndex] (inclusive).
 *
 * Both ends are anchored to actually-matched DOM words rather than trusting a
 * 1:1 token count, because the record's tokenization can drift from the DOM's
 * (punctuation splits, em-dashes, an interleaved caption word, etc.). The start
 * matches the first token within a forward window; the end matches the last
 * token within a window around the *expected* end. Anchoring the end matters
 * for continuous-range highlighting: an overshoot no longer paints a solid
 * block into the next paragraph, it just lands on the real final word.
 */
function buildSentenceWordRanges(sentences, wordEntries) {
  const ranges = new Map();
  const normalize = (s) =>
    String(s)
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '');
  const norm = wordEntries.map((e) => normalize(e.word));
  const START_WINDOW = 80;
  const END_WINDOW = 12;
  let cursor = 0;

  sentences.forEach((sentText, i) => {
    const tokens = tokenizeText(sentText);
    if (tokens.length === 0) return;

    // Anchor the start: first token within a forward window from the cursor.
    const targetFirst = normalize(tokens[0]);
    let startIdx = -1;
    for (let k = cursor; k < Math.min(norm.length, cursor + START_WINDOW); k++) {
      if (norm[k] === targetFirst) {
        startIdx = k;
        break;
      }
    }
    if (startIdx === -1) startIdx = cursor;

    // Position the end would land at if tokens mapped 1:1 with DOM words.
    const expectedEnd = Math.min(norm.length - 1, startIdx + tokens.length - 1);

    let endIdx;
    if (tokens.length === 1) {
      endIdx = startIdx;
    } else {
      // Anchor the end: last token nearest the expected end position, so token
      // drift doesn't run the range past the sentence's true final word.
      const targetLast = normalize(tokens[tokens.length - 1]);
      const lo = Math.max(startIdx, expectedEnd - END_WINDOW);
      const hi = Math.min(norm.length - 1, expectedEnd + END_WINDOW);
      let best = -1;
      for (let k = lo; k <= hi; k++) {
        if (
          norm[k] === targetLast &&
          (best === -1 || Math.abs(k - expectedEnd) < Math.abs(best - expectedEnd))
        ) {
          best = k;
        }
      }
      endIdx = best >= startIdx ? best : expectedEnd;
    }

    ranges.set(i + 1, { startIdx, endIdx });
    cursor = endIdx + 1;
  });

  return ranges;
}

function getTopicSentenceNumbers(topic) {
  if (Array.isArray(topic.sentences) && topic.sentences.length) {
    return topic.sentences.slice().sort((a, b) => a - b);
  }
  const set = new Set();
  (topic.ranges || []).forEach((r) => {
    const s = Number(r.sentence_start);
    const rawEnd =
      r.sentence_end === null || r.sentence_end === undefined || r.sentence_end === ''
        ? r.sentence_start
        : r.sentence_end;
    const e = Number(rawEnd);
    if (!Number.isInteger(s) || !Number.isInteger(e)) return;
    for (let i = Math.min(s, e); i <= Math.max(s, e); i++) set.add(i);
  });
  return Array.from(set).sort((a, b) => a - b);
}

function splitPath(name) {
  return String(name || '')
    .split('>')
    .map((p) => p.trim())
    .filter(Boolean);
}

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return Math.abs(h) % 360;
}

function topicAccentColor(path, depth) {
  const root = splitPath(path)[0] || '';
  const hue = hashHue(root);
  const sat = Math.max(30, 60 - depth * 6);
  const light = Math.min(62, 38 + depth * 6);
  return `hsl(${hue}, ${sat}%, ${light}%)`;
}

/**
 * Build summary cards from record: one card per node in topic_summary_index
 * (preferred) or fall back to leaf topic_summaries.
 */
function buildSummaryEntries(record) {
  const out = [];
  const index = record.topic_summary_index;
  const sentenceNumbersByPath = new Map();

  if (index && typeof index === 'object' && Object.keys(index).length > 0) {
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const parts = splitPath(rawPath);
      const path = parts.join(' > ');
      const sourceSentences = Array.isArray(entry.source_sentences)
        ? entry.source_sentences.slice().sort((a, b) => a - b)
        : [];
      const level = typeof entry.level === 'number' ? entry.level : parts.length - 1;
      sentenceNumbersByPath.set(path, sourceSentences);
      out.push({
        path,
        name: parts[parts.length - 1] || path,
        text: (entry.text || '').trim(),
        sourceSentences,
        level,
      });
    }
  } else {
    const topics = Array.isArray(record.topics) ? record.topics : [];
    const summaries = record.topic_summaries || {};
    for (const topic of topics) {
      const parts = splitPath(topic.name);
      const path = parts.join(' > ');
      const summary = summaries[topic.name] || summaries[path] || {};
      const sourceSentences = (
        Array.isArray(summary.source_sentences)
          ? summary.source_sentences
          : getTopicSentenceNumbers(topic)
      )
        .slice()
        .sort((a, b) => a - b);
      sentenceNumbersByPath.set(path, sourceSentences);
      out.push({
        path,
        name: parts[parts.length - 1] || path,
        text: (summary.text || '').trim(),
        sourceSentences,
        level: parts.length - 1,
      });
    }
  }
  return { entries: out, sentenceNumbersByPath };
}

function buildHierarchicalTopicEntries(record, selectedLevel) {
  const topics = Array.isArray(record.topics) ? record.topics : [];
  const nodes = new Map();

  for (const t of topics) {
    const parts = splitPath(t.name);
    const limit = Math.min(parts.length, selectedLevel + 1);
    const sentences = getTopicSentenceNumbers(t);

    for (let i = 0; i < limit; i++) {
      const path = parts.slice(0, i + 1).join(' > ');
      const name = parts[i];
      if (!nodes.has(path)) {
        nodes.set(path, {
          path,
          name,
          level: i,
          sentences: new Set(),
        });
      }
      const node = nodes.get(path);
      for (const s of sentences) {
        node.sentences.add(s);
      }
    }
  }

  return Array.from(nodes.values()).map((node) => ({
    path: node.path,
    name: node.name,
    level: node.level,
    sentences: Array.from(node.sentences).sort((a, b) => a - b),
  }));
}

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

async function fetchRecord(key) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'getRecord', key }, (resp) => {
        if (chrome.runtime.lastError) {
          resolve(null);
          return;
        }
        resolve(resp && resp.ok ? resp.record : null);
      });
    } catch (_) {
      resolve(null);
    }
  });
}

function findPickedElements(selectors) {
  if (!Array.isArray(selectors)) return [];
  const found = [];
  for (const sel of selectors) {
    if (!sel) continue;
    try {
      const el = document.querySelector(sel);
      if (el) found.push(el);
    } catch (_) {
      /* invalid selector — skip */
    }
  }
  return found;
}

async function openInPageRail(rec, initialMode, options = {}) {
  closeInPageRail();
  removeCanvasIframe();

  // Always re-fetch to get the latest data even if widget data is stale.
  const record = await fetchRecord(rec.key);
  if (!record || record.status !== 'done') {
    alert('PageToLLM: record is not ready yet.');
    return;
  }
  const selectors = Array.isArray(record.selectors) ? record.selectors : [];
  if (selectors.length === 0) {
    alert('PageToLLM: this record has no saved selectors; open it in the canvas view instead.');
    return;
  }
  const elements = findPickedElements(selectors);
  if (elements.length === 0) {
    alert(
      'PageToLLM: could not locate the original article blocks on this page; the layout may have changed.',
    );
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

  const setRailWidthForMode = () => {
    const railWidth = IN_PAGE_RAIL_WIDTHS[state.mode] || IN_PAGE_RAIL_WIDTHS.topics;
    railEl.style.width = `${railWidth}px`;
    document.documentElement.style.setProperty(
      '--pagetollm-rail-reserve',
      `${railWidth + IN_PAGE_RAIL_RESERVE_GAP}px`,
    );
    document.documentElement.style.setProperty('--pagetollm-rail-width', `${railWidth}px`);
  };
  document.documentElement.appendChild(railEl);

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

  function splitIntoContiguousRuns(sentences) {
    const sorted = (sentences || []).slice().sort((a, b) => a - b);
    const runs = [];
    let cur = [];
    for (const s of sorted) {
      if (cur.length === 0 || s === cur[cur.length - 1] + 1) {
        cur.push(s);
      } else {
        runs.push(cur);
        cur = [s];
      }
    }
    if (cur.length) runs.push(cur);
    return runs;
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
    cardSpecs.sort((a, b) => a.box.top - b.box.top);

    const railHeight = cardSpecs.length
      ? Math.max(...cardSpecs.map((c) => c.box.top + c.box.height)) + 80
      : 200;
    return { cards: cardSpecs, bodyHeight: railHeight };
  }

  function renderRail({ measureOnly = false } = {}) {
    const { cards, bodyHeight } = railOriginTop ? buildRailCards() : { cards: [], bodyHeight: 200 };
    flushSync(() => {
      railRoot.render(
        <InPageRail
          recordKey={record.key}
          mode={state.mode}
          maxLevel={maxLevel}
          selectedLevel={state.selectedLevel}
          cards={measureOnly ? [] : cards}
          bodyHeight={measureOnly ? 200 : bodyHeight}
          onClose={closeInPageRail}
          onSelectMode={(mode) => {
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
          }}
          onSelectLevel={(level) => {
            if (state.selectedLevel === level) return;
            state.selectedLevel = level;
            clearAllHighlights();
            renderRail();
          }}
          onHighlightCard={(card, on) => {
            const sentenceList = card.sentences || card.sourceSentences || [];
            highlightTopic(sentenceList, on);
          }}
          onScrollToCard={(card) => {
            const sentenceList = card.sentences || card.sourceSentences || [];
            scrollToFirst(sentenceList);
          }}
          scrollContainer={scrollContainer}
        />,
      );
    });
  }

  renderRail({ measureOnly: true });
  const bodyRect = railEl.querySelector('.pagetollm-rail-body').getBoundingClientRect();
  railOriginTop = getRailOriginTop(bodyRect, scrollContainer);
  renderRail();

  if (options && options.sentenceNumbers && options.sentenceNumbers.length > 0) {
    requestAnimationFrame(() => {
      highlightTopic(options.sentenceNumbers, true);
      scrollToFirst(options.sentenceNumbers);
    });
  }

  inPageRailController = {
    railEl,
    teardown() {
      railRoot.unmount();
      railEl.remove();
      if (supportsHighlightApi()) CSS.highlights.delete(HIGHLIGHT_NAME);
      document.body.classList.remove('pagetollm-rail-open');
      document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
      document.documentElement.style.removeProperty('--pagetollm-rail-width');
    },
  };
}

function closeInPageRail() {
  if (inPageRailController) {
    try {
      inPageRailController.teardown();
    } catch (_) {
      /* noop */
    }
    inPageRailController = null;
  }
}
