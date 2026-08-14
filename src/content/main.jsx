import { createRoot } from 'react-dom/client';
import { createContentSurfaceCoordinator } from './surfaceCoordinator.js';
import * as preferences from './shared/surfacePreferences.js';
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
const surfaces = createContentSurfaceCoordinator({
  document,
  rootFactory: createRoot,
  preferences,
  runtimeMessenger,
  dialogs,
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.action) return false;
  if (message.action === 'startSelection') {
    try {
      surfaces.openSelection();
      sendResponse({ status: 'ready' });
    } catch (err) {
      sendResponse({ status: 'error', error: err?.message || String(err) });
    }
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
    });
  }
});

async function handleRecordViewRequest(rec, mode, rail) {
  if (mode === 'canvas') {
    surfaces.openRecordFrame(rec.key);
    return;
  }
  if (mode === 'hierarchy') {
    surfaces.openRecordFrame(rec.key, 'hierarchy');
    return;
  }
  await surfaces.openRail(rec, mode, rail);
}
