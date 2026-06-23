export function buildTopicNavigationList({
  showSummaryMode,
  summaryCards,
  topicCards,
  selectedLevel,
}) {
  const cards = showSummaryMode ? summaryCards : topicCards;
  if (!Array.isArray(cards)) return [];

  return cards
    .filter((card) => card.levelIndex === selectedLevel)
    .slice()
    .sort((a, b) => {
      const leftPath = showSummaryMode ? a.path : a.fullPath;
      const rightPath = showSummaryMode ? b.path : b.fullPath;
      return a.startSentence - b.startSentence || leftPath.localeCompare(rightPath);
    });
}

export function getTopicNavigationCardTop(card, showSummaryMode, summaryMetricsState) {
  if (!showSummaryMode) return card.top ?? 0;
  return summaryMetricsState.get(card.key)?.top ?? summaryMetricsState.get(card.path)?.top ?? 0;
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
      let currentIndex = matchingIndices[0];
      if (matchingIndices.length > 1) {
        let minDiff = Infinity;
        matchingIndices.forEach((idx) => {
          const diff = Math.abs(
            getTopicNavigationCardTop(list[idx], showSummaryMode, summaryMetricsState) - currentY,
          );
          if (diff < minDiff) {
            minDiff = diff;
            currentIndex = idx;
          }
        });
      }

      targetIndex =
        direction === 'next'
          ? Math.min(list.length - 1, currentIndex + 1)
          : Math.max(0, currentIndex - 1);
    }
  }

  if (targetIndex === -1) {
    let minDiff = Infinity;
    list.forEach((card, idx) => {
      const diff = Math.abs(
        getTopicNavigationCardTop(card, showSummaryMode, summaryMetricsState) - currentY,
      );
      if (diff < minDiff) {
        minDiff = diff;
        targetIndex = idx;
      }
    });
  }

  return list[targetIndex] || null;
}
