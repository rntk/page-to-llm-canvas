const TOPIC_DIRECTION_BY_POSITION = {
  'first-topic': 'first',
  'prev-topic': 'prev',
  'next-topic': 'next',
  'last-topic': 'last',
};

export function buildTopicNavigationList({
  showSummaryMode,
  summaryCards,
  topicCards,
  selectedLevel,
}) {
  if (showSummaryMode) {
    if (!Array.isArray(summaryCards)) return [];
    return summaryCards.slice();
  }

  const cards = topicCards;
  if (!Array.isArray(cards)) return [];

  const eligible = cards.filter((card) => card.levelIndex <= selectedLevel);
  const paths = new Set(eligible.map((card) => card.fullPath).filter(Boolean));
  const hasDescendant = new Set();

  for (const path of paths) {
    let sep = path.indexOf(' > ');
    while (sep !== -1) {
      hasDescendant.add(path.slice(0, sep));
      sep = path.indexOf(' > ', sep + 3);
    }
  }

  return eligible
    .filter((card) => !hasDescendant.has(card.fullPath))
    .slice()
    .sort((a, b) => {
      const leftPath = a.fullPath;
      const rightPath = b.fullPath;
      return a.startSentence - b.startSentence || leftPath.localeCompare(rightPath);
    });
}

export function getTopicNavigationCardKey(card, showSummaryMode) {
  if (!card) return null;
  return showSummaryMode ? card.key || card.path || null : card.key || card.fullPath || null;
}

export function getTopicNavigationTopicKey(card, showSummaryMode) {
  if (!card) return null;
  return showSummaryMode ? card.path || null : card.fullPath || null;
}

export function getTopicNavigationCardTop(card, showSummaryMode, summaryMetricsState = new Map()) {
  if (!showSummaryMode) return card.top ?? 0;
  return summaryMetricsState.get(card.key)?.top ?? summaryMetricsState.get(card.path)?.top ?? null;
}

function findClosestCardIndex(indices, list, showSummaryMode, summaryMetricsState, currentY) {
  if (!Array.isArray(indices) || indices.length === 0) return -1;
  let bestIdx = -1;
  let minDiff = Infinity;
  for (let i = 0; i < indices.length; i++) {
    const idx = indices[i];
    const top = getTopicNavigationCardTop(list[idx], showSummaryMode, summaryMetricsState);
    if (!Number.isFinite(top)) continue;
    const diff = Math.abs(top - currentY);
    if (diff < minDiff) {
      minDiff = diff;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

export function findTopicNavigationTarget({
  list,
  selectedNavigationKey,
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
  if (selectedNavigationKey) {
    targetIndex = list.findIndex(
      (card) => getTopicNavigationCardKey(card, showSummaryMode) === selectedNavigationKey,
    );
    if (targetIndex !== -1) {
      targetIndex =
        direction === 'next'
          ? Math.min(list.length - 1, targetIndex + 1)
          : Math.max(0, targetIndex - 1);
    }
  }

  if (targetIndex === -1 && selectedTopicKey) {
    const matchingIndices = [];
    list.forEach((card, idx) => {
      if (getTopicNavigationTopicKey(card, showSummaryMode) === selectedTopicKey) {
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

  if (targetIndex === -1) return null;
  return list[targetIndex] || null;
}

/**
 * Resolve a control position into the topic card and selection identities the
 * hook should apply. Non-topic positions remain available to canvas navigation.
 * @param {object} options Navigation state.
 */
export function resolveCanvasTopicNavigation({
  position,
  showSummaryMode,
  summaryCards,
  topicCards,
  selectedLevel,
  selectedNavigationKey,
  selectedTopicKey,
  currentY,
  summaryMetricsState = new Map(),
}) {
  const direction = TOPIC_DIRECTION_BY_POSITION[position];
  if (!direction) return { handled: false, targetCard: null };

  const list = buildTopicNavigationList({
    showSummaryMode,
    summaryCards,
    topicCards,
    selectedLevel,
  });
  const targetCard = findTopicNavigationTarget({
    list,
    selectedNavigationKey,
    selectedTopicKey,
    direction,
    currentY,
    showSummaryMode,
    summaryMetricsState,
  });

  if (!targetCard) return { handled: true, targetCard: null };
  return {
    handled: true,
    targetCard,
    topicKey: getTopicNavigationTopicKey(targetCard, showSummaryMode),
    cardKey: getTopicNavigationCardKey(targetCard, showSummaryMode),
  };
}

/** Build the transform needed to place a topic one fifth down the viewport.
 * @param {object} options Topic card and viewport state.
 */
export function buildCanvasTopicPan({
  card,
  showSummaryMode,
  summaryMetricsState = new Map(),
  viewportHeight,
  scale,
  translate,
}) {
  if (!card) return null;
  const cardTop = getTopicNavigationCardTop(card, showSummaryMode, summaryMetricsState);
  if (!Number.isFinite(cardTop)) return null;

  const currentScale = scale || 1;
  return {
    scale: currentScale,
    translate: {
      ...translate,
      y: viewportHeight * 0.2 - cardTop * currentScale,
    },
  };
}
