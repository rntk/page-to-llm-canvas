import { showSelectionToolbar } from './selection/controller.jsx';
import {
  openCanvasIframe,
  openHierarchyIframe,
  removeCanvasIframe,
  getCanvasIframe,
  setRailCloser,
} from './record-view/iframeManager.js';
import { openInPageRail } from './rails/in-page/controller.jsx';
import { openYouTubeRail } from './rails/youtube/controller.jsx';
import { closeInPageRail } from './rails/shared/surface.js';

// The iframe manager and the rail controllers are mutually exclusive but must
// not import each other. Inject the rail closer so opening an iframe can tear
// down an open rail without a circular import.
setRailCloser(closeInPageRail);

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
    handleRecordViewRequest({ key }, mode, message.rail)
      .then(() => sendResponse({ status: 'ok' }))
      .catch((err) =>
        sendResponse({ status: 'error', error: err && err.message ? err.message : String(err) }),
      );
    return true;
  }
  return true;
});

const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;

window.addEventListener('message', (event) => {
  const canvasIframe = getCanvasIframe();
  if (
    !canvasIframe ||
    event.source !== canvasIframe.contentWindow ||
    event.origin !== extensionOrigin
  ) {
    return;
  }

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

async function handleRecordViewRequest(rec, mode, rail) {
  if (mode === 'canvas') {
    openCanvasIframe(rec.key);
    return;
  }
  if (mode === 'hierarchy') {
    openHierarchyIframe(rec.key);
    return;
  }
  if (rail === 'youtube') {
    await openYouTubeRail(rec, mode);
    return;
  }
  await openInPageRail(rec, mode);
}
