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

/**
 * Ask the host page (the modal runs in an iframe) to tear down the modal.
 * The content script listens for this message — see content/main.jsx.
 */
export function closeModal() {
  try {
    if (window.parent === window) {
      window.close();
      return;
    }
    const message = { type: 'pagetollm-close' };
    const parentOrigin = getParentOrigin();
    window.parent.postMessage(message, parentOrigin);

    // `ancestorOrigins`/`document.referrer` can be unavailable or unreliable
    // for extension iframes in some browsers. The content-script receiver
    // authenticates this message by both `event.source` and `event.origin`, so
    // a wildcard target is a safe delivery fallback for this close command.
    if (parentOrigin !== '*') {
      window.parent.postMessage(message, '*');
    }
  } catch (_) {
    /* noop */
  }
}
