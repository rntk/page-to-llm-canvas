function getParentOrigin(hostWindow, hostDocument) {
  const ancestorOrigin = hostWindow.location.ancestorOrigins?.[0];
  if (ancestorOrigin && ancestorOrigin !== 'null') return ancestorOrigin;

  try {
    const referrerOrigin = new URL(hostDocument.referrer).origin;
    if (referrerOrigin !== 'null') return referrerOrigin;
  } catch (_) {
    /* noop */
  }

  return '*';
}

/** Adapter for the iframe-to-content-script modal protocol; exposes only semantic actions. */
export function createModalHost({
  window: hostWindow = globalThis.window,
  document: hostDocument = globalThis.document,
} = {}) {
  const postToParent = (message) => {
    hostWindow.parent.postMessage(message, getParentOrigin(hostWindow, hostDocument));
  };

  return Object.freeze({
    onClose() {
      try {
        if (hostWindow.parent === hostWindow) {
          hostWindow.close();
          return;
        }
        const message = { type: 'pagetollm-close' };
        const parentOrigin = getParentOrigin(hostWindow, hostDocument);
        hostWindow.parent.postMessage(message, parentOrigin);

        // Safe fallback: the receiver authenticates both event.source and event.origin.
        if (parentOrigin !== '*') hostWindow.parent.postMessage(message, '*');
      } catch (_) {
        /* noop */
      }
    },

    onNavigateToSentences({ key, rail, sentenceNumbers, level, topicPath }) {
      try {
        postToParent({
          type: 'pagetollm-scroll-to-topic-sentences',
          key,
          rail,
          sentenceNumbers,
          level,
          topicPath,
        });
      } catch (_) {
        /* noop */
      }
    },
  });
}

/**
 * Parses the iframe URL query into the record key and view mode.
 *
 * @param {string} search
 * @returns {{key: string, view: string}}
 */
export function parseModalRoute(search) {
  try {
    const params = new URLSearchParams(search || '');
    return { key: params.get('key') || '', view: params.get('view') || '' };
  } catch (_) {
    return { key: '', view: '' };
  }
}
