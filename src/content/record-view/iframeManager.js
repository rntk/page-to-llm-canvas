import { buildRecordViewIframeSrc } from './url.js';

const ownedIframes = new WeakSet();

function removeStaleIframes(contentDocument) {
  contentDocument.querySelectorAll('#pagetollm-canvas-iframe').forEach((iframe) => {
    if (!ownedIframes.has(iframe)) iframe.remove();
  });
}

/**
 * Owns the record-view iframe for one content-script coordinator instance.
 */
export function createRecordFrameManager({ document: contentDocument, getRuntimeUrl } = {}) {
  let activeIframe = null;

  function getActiveFrame() {
    return activeIframe;
  }

  function close() {
    if (activeIframe) {
      ownedIframes.delete(activeIframe);
      activeIframe.remove();
      activeIframe = null;
    }
  }

  function open(key, view) {
    close();
    // Clean up abandoned hosts without touching frames owned by other live
    // manager instances.
    removeStaleIframes(contentDocument);
    const iframe = contentDocument.createElement('iframe');
    iframe.id = 'pagetollm-canvas-iframe';
    iframe.src = buildRecordViewIframeSrc(getRuntimeUrl, key, view);
    iframe.style.cssText =
      'position:fixed;inset:0;width:100vw;min-width:100vw;height:100vh;min-height:100vh;border:0;z-index:2147483647;';
    contentDocument.documentElement.appendChild(iframe);
    ownedIframes.add(iframe);
    activeIframe = iframe;
    return iframe;
  }

  return { open, close, getActiveFrame };
}
