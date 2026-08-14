import { buildRecordViewIframeSrc } from './url.js';

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
      activeIframe.remove();
      activeIframe = null;
    }
    contentDocument.getElementById('pagetollm-canvas-iframe')?.remove();
  }

  function open(key, view) {
    close();
    const iframe = contentDocument.createElement('iframe');
    iframe.id = 'pagetollm-canvas-iframe';
    iframe.src = buildRecordViewIframeSrc(getRuntimeUrl, key, view);
    iframe.style.cssText =
      'position:fixed;inset:0;width:100vw;min-width:100vw;height:100vh;min-height:100vh;border:0;z-index:2147483647;';
    contentDocument.documentElement.appendChild(iframe);
    activeIframe = iframe;
    return iframe;
  }

  return { open, close, getActiveFrame };
}
