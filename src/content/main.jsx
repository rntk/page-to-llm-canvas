import { createContentSurfaceCoordinator } from './surfaceCoordinator.js';
import { observePageNavigation } from './pageNavigation.js';
import { browserRuntimeMessenger } from '../utils/runtimeMessages.js';

const runtimeMessenger = {
  ...browserRuntimeMessenger,
  getURL: (path) => chrome.runtime.getURL(path),
  openOptionsPage:
    typeof chrome.runtime.openOptionsPage === 'function'
      ? () => chrome.runtime.openOptionsPage()
      : undefined,
};
const dialogs = {
  alert: (...args) => globalThis.alert(...args),
  confirm: (...args) => globalThis.confirm(...args),
};
const loadContentModule =
  globalThis.__pagetollmLoadContentModule ??
  ((path) => import(/* @vite-ignore */ chrome.runtime.getURL(path)));
const surfaces = createContentSurfaceCoordinator({
  document,
  runtimeMessenger,
  dialogs,
  loaders: {
    selection: () => loadContentModule('content-selection.js'),
    inPageRail: () => loadContentModule('content-in-page-rail.js'),
    youTubeRail: () => loadContentModule('content-youtube-rail.js'),
    recordFrame: () => loadContentModule('content-record-frame.js'),
  },
});

observePageNavigation({
  document,
  window,
  onPageChange: () => surfaces.closeActiveSurface(),
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;
  if (message.action === 'startSelection') {
    surfaces
      .openSelection()
      .then((opened) =>
        sendResponse(
          opened === false
            ? { status: 'error', error: 'selection request was superseded' }
            : { status: 'ready' },
        ),
      )
      .catch((err) => sendResponse({ status: 'error', error: err?.message || String(err) }));
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
      .then((opened) =>
        sendResponse(
          opened === false
            ? { status: 'error', error: 'view request was superseded' }
            : { status: 'ok' },
        ),
      )
      .catch((err) =>
        sendResponse({ status: 'error', error: err && err.message ? err.message : String(err) }),
      );
    return true;
  }
  return false;
});

const extensionOrigin = new URL(chrome.runtime.getURL('')).origin;

window.addEventListener('message', (event) => {
  const recordFrame = surfaces.getRecordFrame();
  if (
    !recordFrame ||
    event.source !== recordFrame.contentWindow ||
    event.origin !== extensionOrigin
  ) {
    return;
  }

  const data = event.data;
  if (data?.type === 'pagetollm-close') {
    surfaces.closeActiveSurface();
  } else if (data?.type === 'pagetollm-scroll-to-topic-sentences') {
    const options = {
      sentenceNumbers: data.sentenceNumbers,
      level: data.level,
      topicPath: data.topicPath,
    };
    void surfaces.openRail({ key: data.key }, 'topics', data.rail, options).catch((err) => {
      console.error('PageToLLM rail error:', err);
      dialogs.alert('PageToLLM: Unable to open this view. Reload the page and try again.');
    });
  }
});

async function handleRecordViewRequest(rec, mode, rail) {
  if (mode === 'canvas') {
    return surfaces.openRecordFrame(rec.key);
  }
  if (mode === 'hierarchy') {
    return surfaces.openRecordFrame(rec.key, 'hierarchy');
  }
  return surfaces.openRail(rec, mode, rail);
}
