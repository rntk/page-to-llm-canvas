// Browser-backed capability objects for the composition roots.
//
// Each object exposes exactly the operations its consumers use, not the shape
// of the underlying browser API. Adding a member here without a caller turns
// the capability into a second, thinner copy of `window`, which is what these
// objects exist to avoid: a consumer that takes `pageHost` should be readable
// as "this needs confirm/alert/openExtensionPage", not "this needs the DOM".

/** Browser-backed timer capability (see `HighlightColorSection` debounce). */
export const browserScheduler = Object.freeze({
  setTimeout(callback, delay) {
    return globalThis.setTimeout(callback, delay);
  },
  clearTimeout(id) {
    globalThis.clearTimeout(id);
  },
});

/** Browser-backed modal/navigation capability (see `RecordsSection`). */
export const browserPageHost = Object.freeze({
  confirm(message) {
    return globalThis.confirm(message);
  },
  alert(message) {
    globalThis.alert(message);
  },
  openExtensionPage(path) {
    if (typeof chrome === 'undefined' || typeof chrome.runtime?.getURL !== 'function') return false;
    globalThis.window?.open(chrome.runtime.getURL(path), '_blank');
    return true;
  },
});

/** Browser-backed JSON import/export capability (see `RecordsSection`). */
export const browserFileHost = Object.freeze({
  readJson(file) {
    if (!file) return Promise.reject(new Error('No file selected'));
    return file.text().then((contents) => JSON.parse(contents));
  },
  downloadJson(filename, value) {
    const blob = new Blob([JSON.stringify(value, null, 2) + '\n'], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },
});
