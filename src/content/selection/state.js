import { getRenderedText } from './html.js';

export function renumberSelectedEntries(entries, options = {}) {
  const mutate = options.mutate !== false;
  if (mutate) {
    entries.forEach((entry, index) => {
      entry.originalNumber = index + 1;
    });
    return entries;
  }
  return entries.map((entry, index) => ({
    ...entry,
    originalNumber: index + 1,
  }));
}

export function removeSelectedEntry(entries, index) {
  if (!Number.isInteger(index) || index < 0 || index >= entries.length) {
    return renumberSelectedEntries(entries);
  }
  const next = entries.filter((_, currentIndex) => currentIndex !== index);
  return renumberSelectedEntries(next);
}

export function moveSelectedEntry(entries, fromIndex, toIndex) {
  if (
    !Number.isInteger(fromIndex) ||
    !Number.isInteger(toIndex) ||
    fromIndex < 0 ||
    toIndex < 0 ||
    fromIndex >= entries.length ||
    toIndex >= entries.length ||
    fromIndex === toIndex
  ) {
    return renumberSelectedEntries(entries);
  }

  const next = [...entries];
  const [moved] = next.splice(fromIndex, 1);
  next.splice(toIndex, 0, moved);
  return renumberSelectedEntries(next);
}

export const BLOCK_SNIPPET_LENGTH = 30;
export const BLOCK_SNIPPET_TITLE_LENGTH = 120;

// Walk a little past the longest snippet so whitespace collapsing and trimEnd have room.
const MAX_BLOCK_TEXT_LENGTH = BLOCK_SNIPPET_TITLE_LENGTH * 2;

export function getBlockText(el) {
  if (!el) return '';
  // Plain test doubles without a DOM nodeType expose textContent directly.
  if (typeof el.nodeType !== 'number') {
    const raw = el.textContent;
    return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  }
  // Reuse the capture-side rendered-text walk so toolbar labels match the
  // submitted text (hidden subtrees, block boundaries, visibility handling).
  // A fresh cache per block resolves each ancestor's style once instead of
  // once per text node; the walk itself stops at the snippet budget.
  const raw = getRenderedText(el, el.ownerDocument?.defaultView, MAX_BLOCK_TEXT_LENGTH, new Map());
  return raw.replace(/\s+/g, ' ').trim();
}

export function truncateSnippet(text, maxLength) {
  if (!text || maxLength <= 0) return '';
  if (text.length <= maxLength) return text;
  const sliced = text.slice(0, maxLength).replace(/[\uD800-\uDBFF]$/, '');
  return `${sliced.trimEnd()}…`;
}

export function buildBlockSnippets(el) {
  const text = getBlockText(el);
  if (!text) return { snippet: '', snippetTitle: '' };
  return {
    snippet: truncateSnippet(text, BLOCK_SNIPPET_LENGTH),
    snippetTitle: truncateSnippet(text, BLOCK_SNIPPET_TITLE_LENGTH),
  };
}

export function createSelectedEntry(el, originalNumber) {
  const { snippet, snippetTitle } = buildBlockSnippets(el);
  const entry = {
    el,
    snippet,
    snippetTitle,
  };
  if (originalNumber !== undefined) {
    entry.originalNumber = originalNumber;
  }
  return entry;
}

export function selectedBlocksForToolbar(entries, canStepUp) {
  return entries.map((entry) => {
    const { snippet, snippetTitle } =
      entry.snippet === undefined || entry.snippetTitle === undefined
        ? buildBlockSnippets(entry.el)
        : entry;
    return {
      id: entry.originalNumber,
      originalNumber: entry.originalNumber,
      canStepUp: typeof canStepUp === 'function' ? canStepUp(entry.el) : true,
      snippet,
      snippetTitle,
    };
  });
}

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

  const { snippet, snippetTitle } = buildBlockSnippets(parent);
  const next = entries.map((currentEntry, currentIndex) =>
    currentIndex === index ? { ...currentEntry, el: parent, snippet, snippetTitle } : currentEntry,
  );
  return {
    entries: renumberSelectedEntries(next, { mutate: false }),
    oldElement: entry.el,
    newElement: parent,
  };
}
