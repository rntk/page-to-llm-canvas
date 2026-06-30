import { renumberSelectedEntries } from './selectionState.js';

export function canStepUpElement(el, boundaries = {}) {
  const parent = el && el.parentElement;
  const body = boundaries.body ?? document.body;
  const documentElement = boundaries.documentElement ?? document.documentElement;
  return Boolean(parent && parent !== body && parent !== documentElement);
}

export function stepUpSelectedEntry(entries, index, boundaries = {}) {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    return {
      entries,
      oldElement: null,
      newElement: null,
    };
  }

  const entry = entries[index];
  if (!entry || !canStepUpElement(entry.el, boundaries)) {
    return {
      entries,
      oldElement: null,
      newElement: null,
    };
  }

  const parent = entry.el.parentElement;
  const parentIndex = entries.findIndex(
    (candidate, candidateIndex) => candidateIndex !== index && candidate.el === parent,
  );

  if (parentIndex >= 0) {
    const next = entries.filter((_, currentIndex) => currentIndex !== index);
    return {
      entries: renumberSelectedEntries(next, { mutate: false }),
      oldElement: entry.el,
      newElement: parent,
    };
  }

  const next = entries.map((currentEntry, currentIndex) =>
    currentIndex === index ? { ...currentEntry, el: parent } : currentEntry,
  );
  return {
    entries: renumberSelectedEntries(next, { mutate: false }),
    oldElement: entry.el,
    newElement: parent,
  };
}

export function buildRecordViewIframeSrc(getUrl, key, view) {
  const base = getUrl('modal.html');
  const params = [`key=${encodeURIComponent(key)}`];
  if (view && view !== 'canvas') {
    params.push(`view=${encodeURIComponent(view)}`);
  }
  return `${base}?${params.join('&')}`;
}
