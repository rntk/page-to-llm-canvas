export function renumberSelectedEntries(entries) {
  entries.forEach((entry, index) => {
    entry.originalNumber = index + 1;
  });
  return entries;
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
