import { useCallback, useEffect, useRef } from 'react';
import { buildSentenceDomRange } from './sentenceHighlight.js';
import {
  buildTopicNavigationList,
  findTopicNavigationTarget,
  getTopicNavigationCardKey,
  getTopicNavigationCardTop,
  getTopicNavigationTopicKey,
} from './topicNavigation.js';

const TOPIC_DIRECTION_BY_POSITION = {
  'first-topic': 'first',
  'prev-topic': 'prev',
  'next-topic': 'next',
  'last-topic': 'last',
};

/** Coordinates topic navigation with the canvas transform and live DOM ranges. */
export function useCanvasTopicNavigation({
  showSummaryMode,
  setShowSummaryMode,
  summaryCardRefs,
  summaryCards,
  summaryMetricsState,
  zoomAdjustedTopicCards,
  selectedLevel,
  selectedTopicKey,
  selectedTopicCardKey,
  setSelectedTopicKey,
  setSelectedTopicCardKey,
  refreshSentenceRanges,
  zoomToTarget,
  canvasWrapElRef,
  scaleRef,
  translateRef,
  setTransformNow,
  flashFocus,
  navigateCanvas,
  skipNextAlignment,
}) {
  const pendingZoomSentenceRef = useRef(null);

  const zoomToTopic = useCallback(
    (topicKey, card) => {
      if (!topicKey) return;
      if (showSummaryMode) {
        const summaryEl =
          (card && summaryCardRefs.current[card.key]) ||
          summaryCardRefs.current[topicKey] ||
          Object.entries(summaryCardRefs.current).find(([key]) => {
            const path = key.split('#')[0];
            return path === topicKey || path.startsWith(topicKey + ' > ');
          })?.[1];
        if (summaryEl) zoomToTarget(summaryEl.getBoundingClientRect());
        return;
      }

      const sentenceNumber = Number(card?.startSentence);
      const { wordEntries, sentenceRanges } = refreshSentenceRanges();
      const domRange =
        Number.isInteger(sentenceNumber) && sentenceNumber > 0
          ? buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber)
          : null;
      if (domRange) zoomToTarget(domRange.getBoundingClientRect());
    },
    [showSummaryMode, summaryCardRefs, zoomToTarget, refreshSentenceRanges],
  );

  useEffect(() => {
    // Wait for article mode to mount before resolving the queued sentence to a
    // live DOM range.
    if (showSummaryMode || pendingZoomSentenceRef.current === null) return;
    const sentenceNumber = Number(pendingZoomSentenceRef.current);
    pendingZoomSentenceRef.current = null;
    if (!Number.isInteger(sentenceNumber) || sentenceNumber <= 0) return;

    const { wordEntries, sentenceRanges } = refreshSentenceRanges();
    const domRange = buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber);
    if (domRange) zoomToTarget(domRange.getBoundingClientRect());
  }, [showSummaryMode, zoomToTarget, refreshSentenceRanges]);

  const panToTopic = useCallback(
    (card) => {
      const wrap = canvasWrapElRef.current;
      if (!wrap || !card) return;
      const currentScale = scaleRef.current || 1;
      const currentTranslate = translateRef.current;
      const cardTop = getTopicNavigationCardTop(card, showSummaryMode, summaryMetricsState);
      if (!Number.isFinite(cardTop)) return;
      setTransformNow(currentScale, {
        ...currentTranslate,
        y: wrap.clientHeight * 0.2 - cardTop * currentScale,
      });
      flashFocus();
    },
    [
      canvasWrapElRef,
      flashFocus,
      scaleRef,
      setTransformNow,
      showSummaryMode,
      summaryMetricsState,
      translateRef,
    ],
  );

  const handleNavigate = useCallback(
    (position) => {
      const direction = TOPIC_DIRECTION_BY_POSITION[position];
      if (!direction) {
        navigateCanvas(position);
        return;
      }

      const list = buildTopicNavigationList({
        showSummaryMode,
        summaryCards,
        topicCards: zoomAdjustedTopicCards,
        selectedLevel,
      });
      const currentY = -translateRef.current.y / (scaleRef.current || 1);
      const targetCard = findTopicNavigationTarget({
        list,
        selectedNavigationKey: selectedTopicCardKey,
        selectedTopicKey,
        direction,
        currentY,
        showSummaryMode,
        summaryMetricsState,
      });

      if (!targetCard) return;
      setSelectedTopicKey(getTopicNavigationTopicKey(targetCard, showSummaryMode));
      setSelectedTopicCardKey(getTopicNavigationCardKey(targetCard, showSummaryMode));
      panToTopic(targetCard);
    },
    [
      navigateCanvas,
      panToTopic,
      scaleRef,
      selectedLevel,
      selectedTopicCardKey,
      selectedTopicKey,
      setSelectedTopicCardKey,
      setSelectedTopicKey,
      showSummaryMode,
      summaryCards,
      summaryMetricsState,
      translateRef,
      zoomAdjustedTopicCards,
    ],
  );

  const handleShowSourceSentences = useCallback(
    (card) => {
      // The pending zoom owns positioning after the article mounts, so suppress
      // alignment to avoid a glide followed by an immediate correction.
      skipNextAlignment();
      pendingZoomSentenceRef.current = card.startSentence;
      setSelectedTopicKey(card.path);
      setSelectedTopicCardKey(card.key || card.path);
      setShowSummaryMode(false);
    },
    [skipNextAlignment, setSelectedTopicKey, setSelectedTopicCardKey, setShowSummaryMode],
  );

  return { zoomToTopic, panToTopic, handleNavigate, handleShowSourceSentences };
}
