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

/**
 * Browser adapter for the iframe-to-content-script modal protocol. UI
 * components receive only the semantic actions returned here.
 */
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

        // The content-script receiver authenticates both event.source and
        // event.origin, so this remains a safe delivery fallback.
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
