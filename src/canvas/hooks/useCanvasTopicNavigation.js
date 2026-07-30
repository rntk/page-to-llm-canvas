import { useCallback, useEffect, useRef } from 'react';
import { buildSentenceDomRange } from '../../highlights/sentenceHighlight.js';
import { buildCanvasTopicPan, resolveCanvasTopicNavigation } from '../../domain/topicNavigation.js';

/**
 * Coordinates topic navigation with the canvas transform and live DOM ranges.
 *
 * Takes the canvas transform's imperative `viewport` handle (live transform refs
 * plus `setTransformNow`/`zoomToTarget`) rather than its members individually;
 * `flashFocus` and `navigateCanvas` stay separate because they are not part of
 * that handle.
 * @param {object} options Navigation hook dependencies.
 */
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
  viewport,
  flashFocus,
  navigateCanvas,
  skipNextAlignment,
}) {
  const { zoomToTarget, canvasWrapElRef, scaleRef, translateRef, setTransformNow } = viewport;
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
      const pan = buildCanvasTopicPan({
        card,
        showSummaryMode,
        summaryMetricsState,
        viewportHeight: wrap.clientHeight,
        scale: scaleRef.current,
        translate: translateRef.current,
      });
      if (!pan) return;
      setTransformNow(pan.scale, pan.translate);
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
      const navigation = resolveCanvasTopicNavigation({
        position,
        showSummaryMode,
        summaryCards,
        topicCards: zoomAdjustedTopicCards,
        selectedLevel,
        selectedNavigationKey: selectedTopicCardKey,
        selectedTopicKey,
        currentY: -translateRef.current.y / (scaleRef.current || 1),
        summaryMetricsState,
      });
      if (!navigation.handled) {
        navigateCanvas(position);
        return;
      }
      if (!navigation.targetCard) return;
      setSelectedTopicKey(navigation.topicKey);
      setSelectedTopicCardKey(navigation.cardKey);
      panToTopic(navigation.targetCard);
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
