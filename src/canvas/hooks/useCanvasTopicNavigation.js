import { useCallback, useEffect, useRef } from 'react';
import { buildSentenceDomRange } from '../../highlights/sentenceHighlight.js';
import { buildCanvasTopicPan, resolveCanvasTopicNavigation } from '../../domain/topicNavigation.js';
import { isDescendantPath } from '../../shared/runtime/topicPath.js';

/**
 * Coordinates topic navigation with the canvas transform and live DOM ranges.
 *
 * Takes the canvas transform's `viewport` handle; `flashFocus` and `navigateCanvas`
 * are separate because they are not part of it.
 * @param {object} options Navigation hook dependencies.
 */
export function useCanvasTopicNavigation({
  showSummaryMode,
  setShowSummaryMode,
  summaryCardRegistry,
  summaryCards,
  summaryMetricsState,
  zoomAdjustedTopicCards,
  selectedLevel,
  selectedTarget,
  selectTopic,
  refreshSentenceRanges,
  viewport,
  flashFocus,
  navigateCanvas,
  skipNextAlignment,
  captureReturnPoint,
}) {
  const { zoomToTarget, getWrapElement, readTransform, setTransformNow } = viewport;
  const pendingZoomSentenceRef = useRef(null);
  const selectedTopicKey = selectedTarget?.path ?? null;
  const selectedTopicCardKey = selectedTarget?.cardKey ?? null;

  const zoomToTopic = useCallback(
    (topicKey, card) => {
      if (!topicKey) return;
      if (showSummaryMode) {
        const summaryEl =
          (card && summaryCardRegistry.get(card.key)) ||
          summaryCardRegistry.get(topicKey) ||
          summaryCardRegistry.entries().find(([key]) => {
            const path = key.split('#')[0];
            return path === topicKey || isDescendantPath(path, topicKey);
          })?.[1];
        if (summaryEl) {
          // Capture before the jump, and only if it happens: an unresolved card must not leave a dead return point.
          captureReturnPoint();
          zoomToTarget(summaryEl.getBoundingClientRect());
        }
        return;
      }

      const sentenceNumber = Number(card?.startSentence);
      const { wordEntries, sentenceRanges } = refreshSentenceRanges();
      const domRange =
        Number.isInteger(sentenceNumber) && sentenceNumber > 0
          ? buildSentenceDomRange(sentenceRanges, wordEntries, sentenceNumber)
          : null;
      if (domRange) {
        captureReturnPoint();
        zoomToTarget(domRange.getBoundingClientRect());
      }
    },
    [showSummaryMode, summaryCardRegistry, zoomToTarget, refreshSentenceRanges, captureReturnPoint],
  );

  useEffect(() => {
    // Wait for article mode to mount before resolving the queued sentence.
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
      const wrap = getWrapElement();
      if (!wrap || !card) return;
      const { scale, translate } = readTransform();
      const pan = buildCanvasTopicPan({
        card,
        showSummaryMode,
        summaryMetricsState,
        viewportHeight: wrap.clientHeight,
        scale,
        translate,
      });
      if (!pan) return;
      setTransformNow(pan.scale, pan.translate);
      flashFocus();
    },
    [
      flashFocus,
      getWrapElement,
      readTransform,
      setTransformNow,
      showSummaryMode,
      summaryMetricsState,
    ],
  );

  const handleNavigate = useCallback(
    (position) => {
      const { scale, translate } = readTransform();
      const navigation = resolveCanvasTopicNavigation({
        position,
        showSummaryMode,
        summaryCards,
        topicCards: zoomAdjustedTopicCards,
        selectedLevel,
        selectedNavigationKey: selectedTopicCardKey,
        selectedTopicKey,
        currentY: -translate.y / scale,
        summaryMetricsState,
      });
      if (!navigation.handled) {
        navigateCanvas(position);
        return;
      }
      if (!navigation.targetCard) return;
      selectTopic({ path: navigation.topicKey, cardKey: navigation.cardKey });
      panToTopic(navigation.targetCard);
    },
    [
      navigateCanvas,
      panToTopic,
      readTransform,
      selectedLevel,
      selectedTopicCardKey,
      selectedTopicKey,
      selectTopic,
      showSummaryMode,
      summaryCards,
      summaryMetricsState,
      zoomAdjustedTopicCards,
    ],
  );

  const handleShowSourceSentences = useCallback(
    (card) => {
      // The pending zoom owns positioning; skip alignment to avoid glide-then-correct.
      skipNextAlignment();
      // Capture while still in summary mode so the way back restores that view too.
      captureReturnPoint();
      pendingZoomSentenceRef.current = card.startSentence;
      selectTopic({ path: card.path, cardKey: card.key });
      setShowSummaryMode(false);
    },
    [skipNextAlignment, selectTopic, setShowSummaryMode, captureReturnPoint],
  );

  return { zoomToTopic, panToTopic, handleNavigate, handleShowSourceSentences };
}
