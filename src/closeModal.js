/**
 * Ask the host page (the modal runs in an iframe) to tear down the modal.
 * The content script listens for this message — see content/main.jsx.
 */
export function closeModal() {
  try {
    window.parent.postMessage({ type: 'pagetollm-close' }, '*');
  } catch (_) {
    /* noop */
  }
}
