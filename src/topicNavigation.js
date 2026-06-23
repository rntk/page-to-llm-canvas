export function buildTopicNavigationList({
  showSummaryMode,
  summaryCards,
  topicCards,
  selectedLevel,
}) {
  if (showSummaryMode) {
    if (!Array.isArray(summaryCards)) return [];
    return [...summaryCards].sort(
      (a, b) => a.startSentence - b.startSentence || a.path.localeCompare(b.path),
    );
  }

  const cards = topicCards;
  if (!Array.isArray(cards)) return [];

  return cards
    .filter((card) => card.levelIndex === selectedLevel)
    .slice()
    .sort((a, b) => {
      const leftPath = a.fullPath;
      const rightPath = b.fullPath;
      return a.startSentence - b.startSentence || leftPath.localeCompare(rightPath);
    });
}

export function getTopicNavigationCardTop(card, showSummaryMode, summaryMetricsState) {
  if (!showSummaryMode) return card.top ?? 0;
  return summaryMetricsState.get(card.key)?.top ?? summaryMetricsState.get(card.path)?.top ?? 0;
}

function findClosestCardIndex(indices, list, showSummaryMode, summaryMetricsState, currentY) {
  if (!Array.isArray(indices) || indices.length === 0) return -1;
  let bestIdx = indices[0];
  let minDiff = Math.abs(
    getTopicNavigationCardTop(list[bestIdx], showSummaryMode, summaryMetricsState) - currentY,
  );
  for (let i = 1; i < indices.length; i++) {
    const idx = indices[i];
    const diff = Math.abs(
      getTopicNavigationCardTop(list[idx], showSummaryMode, summaryMetricsState) - currentY,
    );
    if (diff < minDiff) {
      minDiff = diff;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

export function findTopicNavigationTarget({
  list,
  selectedTopicKey,
  direction,
  currentY,
  showSummaryMode,
  summaryMetricsState = new Map(),
}) {
  if (!Array.isArray(list) || list.length === 0) return null;
  if (direction === 'first') return list[0];
  if (direction === 'last') return list[list.length - 1];

  let targetIndex = -1;
  if (selectedTopicKey) {
    const matchingIndices = [];
    list.forEach((card, idx) => {
      if ((showSummaryMode ? card.path : card.fullPath) === selectedTopicKey) {
        matchingIndices.push(idx);
      }
    });

    if (matchingIndices.length > 0) {
      const currentIndex =
        matchingIndices.length === 1
          ? matchingIndices[0]
          : findClosestCardIndex(
              matchingIndices,
              list,
              showSummaryMode,
              summaryMetricsState,
              currentY,
            );

      targetIndex =
        direction === 'next'
          ? Math.min(list.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
    }
  }

  if (targetIndex === -1) {
    const allIndices = list.map((_, idx) => idx);
    targetIndex = findClosestCardIndex(
      allIndices,
      list,
      showSummaryMode,
      summaryMetricsState,
      currentY,
    );
  }

  return list[targetIndex] || null;
}
