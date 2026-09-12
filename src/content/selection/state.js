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

export function selectedBlocksForToolbar(entries, canStepUp) {
  return entries.map((entry) => ({
    id: entry.originalNumber,
    originalNumber: entry.originalNumber,
    canStepUp: typeof canStepUp === 'function' ? canStepUp(entry.el) : true,
  }));
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

  const next = entries.map((currentEntry, currentIndex) =>
    currentIndex === index ? { ...currentEntry, el: parent } : currentEntry,
  );
  return {
    entries: renumberSelectedEntries(next, { mutate: false }),
    oldElement: entry.el,
    newElement: parent,
  };
}
