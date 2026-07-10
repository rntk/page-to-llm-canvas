/**
 * Ask the host page (the modal runs in an iframe) to tear down the modal.
 * The content script listens for this message — see content/main.jsx.
 */
export function getParentOrigin() {
  const ancestorOrigin = window.location.ancestorOrigins?.[0];
  if (ancestorOrigin && ancestorOrigin !== 'null') return ancestorOrigin;

  try {
    const referrerOrigin = new URL(document.referrer).origin;
    if (referrerOrigin !== 'null') return referrerOrigin;
  } catch (_) {
    /* noop */
  }

  // Older/non-browser test environments may expose neither source. Chromium,
  // where this extension runs, provides ancestorOrigins for embedded frames.
  return '*';
}

export function postMessageToParent(message) {
  window.parent.postMessage(message, getParentOrigin());
}

export function closeModal() {
  try {
    if (window.parent === window) {
      window.close();
      return;
    }
    postMessageToParent({ type: 'pagetollm-close' });
  } catch (_) {
    /* noop */
  }
}
