(function () {
  let selectionToolbar = null;
  let selectionMode = false;
  let selectedElements = [];
  let pickCounter = 0;
  let dragSrcIndex = null;
  let canvasIframe = null;
  let pageRecordsWidget = null;

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === "startSelection") {
      showSelectionToolbar();
      sendResponse({ status: "ready" });
    }
    return true;
  });

  window.addEventListener("message", (event) => {
    const data = event.data;
    if (data && data.type === "pagetollm-close") {
      removeCanvasIframe();
    }
  });

  // ── Page records widget ───────────────────────────────────────────────────

  function getRecordHostname(sourceUrl) {
    if (!sourceUrl) return '';
    try { return new URL(sourceUrl).hostname; } catch (_) { return ''; }
  }

  function getUrlLabel(sourceUrl) {
    if (!sourceUrl) return 'Unknown page';
    try {
      const u = new URL(sourceUrl);
      const path = u.pathname + (u.search || '');
      return path.length > 1 ? path : u.hostname;
    } catch (_) {
      return sourceUrl.slice(0, 60);
    }
  }

  function getStatusLabel(status) {
    const map = { done: 'Done', pending: 'Pending', splitting: 'Processing', summarizing: 'Processing', error: 'Error' };
    return map[status] || status || '?';
  }

  function removePageRecordsWidget() {
    if (pageRecordsWidget) {
      pageRecordsWidget.remove();
      pageRecordsWidget = null;
    }
  }

  function updateRecordList(list, records) {
    list.innerHTML = '';
    records.forEach((rec) => {
      const item = document.createElement('li');
      item.className = 'pagetollm-prd-item';

      const label = document.createElement('span');
      label.className = 'pagetollm-prd-label';
      label.textContent = getUrlLabel(rec.sourceUrl);
      label.title = rec.sourceUrl || '';

      const badge = document.createElement('span');
      badge.className = `pagetollm-prd-badge pagetollm-prd-badge--${rec.status || 'unknown'}`;
      badge.textContent = getStatusLabel(rec.status);

      item.appendChild(label);
      item.appendChild(badge);
      item.addEventListener('click', () => openCanvasIframe(rec.key));
      list.appendChild(item);
    });
  }

  function renderPageRecordsWidget(records) {
    const hostname = window.location.hostname;
    const matching = records.filter((r) => getRecordHostname(r.sourceUrl) === hostname);

    if (matching.length === 0) {
      removePageRecordsWidget();
      return;
    }

    if (pageRecordsWidget) {
      const list = pageRecordsWidget.querySelector('#pagetollm-prd-list');
      if (list) { updateRecordList(list, matching); return; }
    }

    const widget = document.createElement('div');
    widget.id = 'pagetollm-page-records-widget';

    const header = document.createElement('div');
    header.className = 'pagetollm-prd-header';

    const title = document.createElement('span');
    title.className = 'pagetollm-prd-title';
    title.textContent = 'Saved analyses';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pagetollm-prd-close';
    closeBtn.textContent = '×';
    closeBtn.title = 'Close';
    closeBtn.addEventListener('click', removePageRecordsWidget);

    header.appendChild(title);
    header.appendChild(closeBtn);

    const list = document.createElement('ul');
    list.id = 'pagetollm-prd-list';
    updateRecordList(list, matching);

    widget.appendChild(header);
    widget.appendChild(list);
    document.documentElement.appendChild(widget);
    pageRecordsWidget = widget;
  }

  function refreshPageRecordsWidget() {
    try {
      chrome.runtime.sendMessage({ type: 'listRecords' }, (resp) => {
        if (chrome.runtime.lastError) return;
        if (resp && resp.ok && Array.isArray(resp.items)) {
          renderPageRecordsWidget(resp.items);
        }
      });
    } catch (_) { /* extension context unavailable */ }
  }

  try {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'local') return;
      if (Object.keys(changes).some((k) => k.startsWith('pagetollm:'))) {
        refreshPageRecordsWidget();
      }
    });
  } catch (_) { /* noop */ }

  refreshPageRecordsWidget();

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
    const html = buildHtml(selectedElements.map(({ el }) => el));

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'submit',
        html,
        sourceUrl
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
})();
