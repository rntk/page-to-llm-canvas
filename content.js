(function () {
  let selectionToolbar = null;
  let selectionMode = false;
  let selectedElements = [];
  let pickCounter = 0;
  let dragSrcIndex = null;
  let canvasIframe = null;
  let inPageRailController = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startSelection") {
      showSelectionToolbar();
      sendResponse({ status: "ready" });
      return true;
    }
    if (message.action === "openRecordView") {
      const key = message.key;
      const mode = message.mode || "canvas";
      if (!key) {
        sendResponse({ status: "error", error: "missing key" });
        return true;
      }
      handleRecordViewRequest({ key }, mode)
        .then(() => sendResponse({ status: "ok" }))
        .catch((err) => sendResponse({ status: "error", error: err && err.message ? err.message : String(err) }));
      return true;
    }
    return true;
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === "pagetollm-close") {
      removeCanvasIframe();
    }
  });

  // ── CSS selector path ─────────────────────────────────────────────────────

  function buildCssPath(el) {
    if (!(el instanceof Element)) return "";
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let selector = node.nodeName.toLowerCase();
      if (node.id) {
        selector += `#${CSS.escape(node.id)}`;
        parts.unshift(selector);
        break;
      }
      let sib = node, nth = 1;
      while ((sib = sib.previousElementSibling)) {
        if (sib.nodeName === node.nodeName) nth++;
      }
      selector += `:nth-of-type(${nth})`;
      parts.unshift(selector);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  // ── Record view actions ───────────────────────────────────────────────────

  async function handleRecordViewRequest(rec, mode) {
    if (mode === 'canvas') {
      openCanvasIframe(rec.key);
      return;
    }
    await openInPageRail(rec, mode);
  }

  // ── Selection toolbar ─────────────────────────────────────────────────────

  function showSelectionToolbar() {
    if (selectionToolbar) {
      selectionToolbar.remove();
    }

    selectionToolbar = document.createElement('div');
    selectionToolbar.id = 'rsstag-selection-toolbar';
    selectionToolbar.innerHTML = `
      <div id="rsstag-toolbar-top">
        <button id="rsstag-pick-btn" type="button">Pick Block</button>
        <button id="rsstag-submit-btn" type="button" disabled>Submit</button>
        <button id="rsstag-cancel-btn" type="button">Cancel</button>
      </div>
      <ul id="rsstag-block-list"></ul>
    `;

    document.body.appendChild(selectionToolbar);

    document.getElementById('rsstag-pick-btn').addEventListener('click', toggleSelectionMode);
    document.getElementById('rsstag-submit-btn').addEventListener('click', submitSelection);
    document.getElementById('rsstag-cancel-btn').addEventListener('click', cleanupSelection);

    renderBlockList();
  }

  function toggleSelectionMode() {
    selectionMode = !selectionMode;
    const pickBtn = document.getElementById('rsstag-pick-btn');

    if (selectionMode) {
      pickBtn.classList.add('active');
      pickBtn.textContent = 'Picking…';
      enableSelection();
    } else {
      pickBtn.classList.remove('active');
      pickBtn.textContent = 'Pick Block';
      disableSelection();
    }
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
    document.querySelectorAll('.rsstag-element-highlight').forEach(el => {
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
    if (el && !selectedElements.some(entry => entry.el === el)) {
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

    const pickBtn = document.getElementById('rsstag-pick-btn');
    pickBtn.classList.remove('active');
    pickBtn.textContent = 'Pick Block';

    renderBlockList();
    updateSubmitState();
  }

  function renderBlockList() {
    const list = document.getElementById('rsstag-block-list');
    if (!list) return;
    list.innerHTML = '';

    selectedElements.forEach(({ el, originalNumber }, index) => {
      const item = document.createElement('li');
      item.className = 'rsstag-block-item';
      item.draggable = true;
      item.dataset.index = index;

      item.innerHTML = `
        <span class="rsstag-drag-handle" title="Drag to reorder">&#9776;</span>
        <span class="rsstag-block-label">Block ${originalNumber}</span>
        <button class="rsstag-remove-btn" type="button" title="Remove block">&#10005;</button>
      `;

      item.querySelector('.rsstag-remove-btn').addEventListener('click', () => removeBlock(index));

      item.addEventListener('dragstart', onDragStart);
      item.addEventListener('dragover', onDragOver);
      item.addEventListener('drop', onDrop);
      item.addEventListener('dragend', onDragEnd);

      list.appendChild(item);
    });
  }

  function removeBlock(index) {
    const entry = selectedElements[index];
    if (entry) {
      entry.el.classList.remove('rsstag-selected');
    }
    selectedElements.splice(index, 1);
    renderBlockList();
    updateSubmitState();
  }

  function onDragStart(event) {
    dragSrcIndex = parseInt(event.currentTarget.dataset.index);
    event.currentTarget.classList.add('rsstag-dragging');
    event.dataTransfer.effectAllowed = 'move';
  }

  function onDragOver(event) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const target = event.currentTarget;
    document.querySelectorAll('.rsstag-block-item').forEach(i => i.classList.remove('rsstag-drag-over'));
    if (parseInt(target.dataset.index) !== dragSrcIndex) {
      target.classList.add('rsstag-drag-over');
    }
  }

  function onDrop(event) {
    event.preventDefault();
    const destIndex = parseInt(event.currentTarget.dataset.index);
    if (dragSrcIndex === null || dragSrcIndex === destIndex) return;

    const moved = selectedElements.splice(dragSrcIndex, 1)[0];
    selectedElements.splice(destIndex, 0, moved);

    renderBlockList();
    updateSubmitState();
  }

  function onDragEnd(event) {
    dragSrcIndex = null;
    document.querySelectorAll('.rsstag-block-item').forEach(i => {
      i.classList.remove('rsstag-dragging', 'rsstag-drag-over');
    });
  }

  function buildHtml(elements) {
    const parts = [];
    for (const el of elements) {
      const clone = el.cloneNode(true);
      if (clone.classList) {
        clone.classList.remove('rsstag-selected', 'rsstag-element-highlight');
      }
      clone.querySelectorAll && clone.querySelectorAll('.rsstag-selected, .rsstag-element-highlight').forEach(c => {
        c.classList.remove('rsstag-selected', 'rsstag-element-highlight');
      });
      parts.push(clone.outerHTML);
    }
    return parts.join('\n');
  }

  function updateSubmitState() {
    const submitBtn = document.getElementById('rsstag-submit-btn');
    if (!submitBtn) return;
    const count = selectedElements.length;
    submitBtn.disabled = count === 0;
    submitBtn.textContent = count > 0 ? `Submit (${count})` : 'Submit';
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
    iframe.style.cssText = 'position:fixed;inset:0;width:100vw;min-width:100vw;height:100vh;min-height:100vh;border:0;z-index:2147483647;';
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
      selectionToolbar.remove();
      selectionToolbar = null;
    }

    selectedElements.forEach(({ el }) => el.classList.remove('rsstag-selected'));
    selectedElements = [];
    pickCounter = 0;

    selectionMode = false;
    disableSelection();
  }

  // ── In-page rail view ─────────────────────────────────────────────────────

  const WORD_TOKEN_RE = /\S+/g;

  function tokenizeText(text) {
    return String(text || '').match(WORD_TOKEN_RE) || [];
  }

  function isSkippableContainer(node) {
    if (!node || node.nodeType !== 1) return false;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') return true;
    if (node.id === 'pagetollm-in-page-rail') return true;
    if (node.classList && node.classList.contains('pagetollm-word')) return true;
    return false;
  }

  /**
   * Walk text nodes within roots and replace each with per-word spans.
   * Returns the global ordered list of word entries: [{ word, span }].
   */
  function wrapWordsInElements(roots) {
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
      const frag = document.createDocumentFragment();
      let lastIndex = 0;
      WORD_TOKEN_RE.lastIndex = 0;
      let m;
      while ((m = WORD_TOKEN_RE.exec(value))) {
        if (m.index > lastIndex) {
          frag.appendChild(document.createTextNode(value.slice(lastIndex, m.index)));
        }
        const span = document.createElement('span');
        span.className = 'pagetollm-word';
        span.dataset.wIdx = String(entries.length);
        span.textContent = m[0];
        frag.appendChild(span);
        entries.push({ word: m[0], span });
        lastIndex = m.index + m[0].length;
      }
      if (lastIndex < value.length) {
        frag.appendChild(document.createTextNode(value.slice(lastIndex)));
      }
      textNode.parentNode.replaceChild(frag, textNode);
    }

    return entries;
  }

  function unwrapWords(roots) {
    roots.forEach((root) => {
      if (!root || !root.querySelectorAll) return;
      root.querySelectorAll('.pagetollm-word').forEach((span) => {
        const text = document.createTextNode(span.textContent);
        span.parentNode.replaceChild(text, span);
      });
      root.normalize && root.normalize();
    });
  }

  /**
   * Map each sentence (1-based) to a [wordStartIndex, wordEndIndex] (inclusive).
   * Sequential walk: tokenize each sentence; expect tokens to match next entries.
   * If a mismatch occurs, scan forward up to a small window to resync.
   */
  function buildSentenceWordRanges(sentences, wordEntries) {
    const ranges = new Map();
    const normalize = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/gi, '');
    let cursor = 0;

    sentences.forEach((sentText, i) => {
      const tokens = tokenizeText(sentText);
      if (tokens.length === 0) return;

      // Find the start by attempting to match the first token within a window.
      const targetFirst = normalize(tokens[0]);
      let startIdx = -1;
      for (let k = cursor; k < Math.min(wordEntries.length, cursor + 80); k++) {
        if (normalize(wordEntries[k].word) === targetFirst) {
          startIdx = k;
          break;
        }
      }
      if (startIdx === -1) startIdx = cursor;

      let endIdx = Math.min(wordEntries.length - 1, startIdx + tokens.length - 1);
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
      const e = Number(r.sentence_end ?? r.sentence_start);
      if (!Number.isInteger(s) || !Number.isInteger(e)) return;
      for (let i = Math.min(s, e); i <= Math.max(s, e); i++) set.add(i);
    });
    return Array.from(set).sort((a, b) => a - b);
  }

  function splitPath(name) {
    return String(name || '').split('>').map((p) => p.trim()).filter(Boolean);
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
        const sourceSentences = (Array.isArray(summary.source_sentences)
          ? summary.source_sentences
          : getTopicSentenceNumbers(topic)).slice().sort((a, b) => a - b);
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

  function buildTopicEntries(record) {
    const topics = Array.isArray(record.topics) ? record.topics : [];
    return topics.map((t) => {
      const parts = splitPath(t.name);
      const path = parts.join(' > ');
      return {
        path,
        name: parts[parts.length - 1] || path,
        level: parts.length - 1,
        sentences: getTopicSentenceNumbers(t),
      };
    });
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


  function computeCardVerticalBox(sentences, sentenceRanges, wordEntries, railOriginTop) {
    if (!sentences || sentences.length === 0) return null;
    let top = Infinity, bottom = -Infinity;
    for (const sNum of sentences) {
      const range = sentenceRanges.get(sNum);
      if (!range) continue;
      const startSpan = wordEntries[range.startIdx] && wordEntries[range.startIdx].span;
      const endSpan = wordEntries[range.endIdx] && wordEntries[range.endIdx].span;
      if (!startSpan || !endSpan) continue;
      const r1 = startSpan.getBoundingClientRect();
      const r2 = endSpan.getBoundingClientRect();
      const sTop = Math.min(r1.top, r2.top) + window.scrollY - railOriginTop;
      const sBottom = Math.max(r1.bottom, r2.bottom) + window.scrollY - railOriginTop;
      if (sTop < top) top = sTop;
      if (sBottom > bottom) bottom = sBottom;
    }
    if (!Number.isFinite(top) || !Number.isFinite(bottom)) return null;
    return { top, height: Math.max(40, bottom - top) };
  }

  async function fetchRecord(key) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: 'getRecord', key }, (resp) => {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp && resp.ok ? resp.record : null);
        });
      } catch (_) { resolve(null); }
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
      } catch (_) { /* invalid selector — skip */ }
    }
    return found;
  }

  async function openInPageRail(rec, mode) {
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
      alert('PageToLLM: could not locate the original article blocks on this page; the layout may have changed.');
      return;
    }

    const wordEntries = wrapWordsInElements(elements);
    const sentences = Array.isArray(record.sentences) ? record.sentences : [];
    const sentenceRanges = buildSentenceWordRanges(sentences, wordEntries);

    let selectedLevel = 0;

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
    railEl.dataset.mode = mode;

    const head = document.createElement('div');
    head.className = 'pagetollm-rail-head';
    const title = document.createElement('span');
    title.className = 'pagetollm-rail-title';
    title.textContent = mode === 'summaries' ? 'Topic summaries' : 'Topics';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pagetollm-rail-close';
    closeBtn.type = 'button';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close rail';
    closeBtn.addEventListener('click', closeInPageRail);

    head.appendChild(title);

    if (maxLevel > 0) {
      const switcher = document.createElement('div');
      switcher.className = 'pagetollm-rail-level-switcher';
      
      const buttonsContainer = document.createElement('div');
      buttonsContainer.className = 'pagetollm-rail-level-buttons';
      
      for (let level = 0; level <= maxLevel; level++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `pagetollm-rail-level-btn${selectedLevel === level ? ' active' : ''}`;
        btn.textContent = `L${level}`;
        btn.title = `Switch to level ${level}`;
        btn.addEventListener('click', () => {
          if (selectedLevel === level) return;
          selectedLevel = level;
          
          buttonsContainer.querySelectorAll('.pagetollm-rail-level-btn').forEach((b, idx) => {
            if (idx === level) b.classList.add('active');
            else b.classList.remove('active');
          });
          
          clearAllHighlights();
          renderCards();
        });
        buttonsContainer.appendChild(btn);
      }
      switcher.appendChild(buttonsContainer);
      head.appendChild(switcher);
    }

    head.appendChild(closeBtn);

    const body = document.createElement('div');
    body.className = 'pagetollm-rail-body';

    railEl.appendChild(head);
    railEl.appendChild(body);
    document.documentElement.appendChild(railEl);

    // Reserve space on the right side of the page so the rail does not overlap text.
    const RAIL_WIDTH = mode === 'summaries' ? 340 : 260;
    railEl.style.width = `${RAIL_WIDTH}px`;
    document.documentElement.style.setProperty('--pagetollm-rail-reserve', `${RAIL_WIDTH + 16}px`);
    document.body.classList.add('pagetollm-rail-open');

    const bodyRect = body.getBoundingClientRect();
    const railOriginTop = bodyRect.top + window.scrollY;

    function clearAllHighlights() {
      const cls = 'is-highlight';
      wordEntries.forEach((entry) => {
        if (entry && entry.span) {
          entry.span.classList.remove(cls);
        }
      });
    }

    function highlightTopic(sentenceList, on) {
      const cls = 'is-highlight';
      for (const sNum of sentenceList) {
        const range = sentenceRanges.get(sNum);
        if (!range) continue;
        for (let k = range.startIdx; k <= range.endIdx; k++) {
          const entry = wordEntries[k];
          if (!entry) continue;
          if (on) entry.span.classList.add(cls);
          else entry.span.classList.remove(cls);
        }
      }
    }

    function scrollToFirst(sentenceList) {
      if (!sentenceList || !sentenceList.length) return;
      const range = sentenceRanges.get(sentenceList[0]);
      if (!range) return;
      const span = wordEntries[range.startIdx] && wordEntries[range.startIdx].span;
      if (span) {
        span.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }

    function renderCards() {
      body.innerHTML = '';

      let cardSpecs;
      if (mode === 'summaries') {
        const { entries } = buildSummaryEntries(record);
        const eligible = entries.filter((e) => e.level === selectedLevel);
        cardSpecs = eligible
          .map((e) => {
            const box = computeCardVerticalBox(e.sourceSentences, sentenceRanges, wordEntries, railOriginTop);
            return { ...e, sentences: e.sourceSentences, box };
          })
          .filter((c) => c.box)
          .sort((a, b) => a.box.top - b.box.top);
      } else {
        const entries = buildHierarchicalTopicEntries(record, selectedLevel);
        const eligible = entries.filter((e) => e.level === selectedLevel);
        cardSpecs = eligible
          .map((e) => {
            const box = computeCardVerticalBox(e.sentences, sentenceRanges, wordEntries, railOriginTop);
            return { ...e, box };
          })
          .filter((c) => c.box)
          .sort((a, b) => a.box.top - b.box.top);
      }

      // De-overlap: bump cards down if they would visually collide.
      const MIN_GAP = 6;
      for (let i = 1; i < cardSpecs.length; i++) {
        const prev = cardSpecs[i - 1].box;
        const cur = cardSpecs[i].box;
        const minTop = prev.top + prev.height + MIN_GAP;
        if (cur.top < minTop) cur.top = minTop;
      }

      const railHeight = cardSpecs.length
        ? Math.max(...cardSpecs.map((c) => c.box.top + c.box.height)) + 80
        : 200;
      body.style.height = `${railHeight}px`;

      for (const spec of cardSpecs) {
        const card = document.createElement('button');
        card.type = 'button';
        const isSummary = mode === 'summaries';
        card.className = `pagetollm-rail-card${isSummary ? ' is-summary' : ''}`;
        card.style.top = `${spec.box.top}px`;
        card.style.minHeight = `${spec.box.height}px`;
        card.style.borderColor = topicAccentColor(spec.path, spec.level || 0);
        card.style.setProperty('--pagetollm-card-accent', topicAccentColor(spec.path, spec.level || 0));

        const content = document.createElement('div');
        content.className = 'pagetollm-rail-card-content';

        const heading = document.createElement('div');
        heading.className = 'pagetollm-rail-card-title';
        heading.textContent = spec.name;
        heading.title = spec.path;
        content.appendChild(heading);

        if (isSummary) {
          const cardBody = document.createElement('div');
          cardBody.className = 'pagetollm-rail-card-body';
          cardBody.textContent = spec.text || '(no summary)';
          content.appendChild(cardBody);
        } else {
          const meta = document.createElement('div');
          meta.className = 'pagetollm-rail-card-meta';
          meta.textContent = `${spec.sentences.length} sent.`;
          content.appendChild(meta);
        }
        card.appendChild(content);

        const sentenceList = spec.sentences || spec.sourceSentences || [];
        card.addEventListener('mouseenter', () => highlightTopic(sentenceList, true));
        card.addEventListener('mouseleave', () => highlightTopic(sentenceList, false));
        card.addEventListener('click', () => scrollToFirst(sentenceList));

        body.appendChild(card);
      }
    }

    renderCards();

    inPageRailController = {
      railEl,
      teardown() {
        railEl.remove();
        unwrapWords(elements);
        document.body.classList.remove('pagetollm-rail-open');
        document.documentElement.style.removeProperty('--pagetollm-rail-reserve');
      },
    };
  }


  function closeInPageRail() {
    if (inPageRailController) {
      try { inPageRailController.teardown(); } catch (_) { /* noop */ }
      inPageRailController = null;
    }
  }
})();
