import { useEffect, useReducer } from 'react';
import { clampScale } from '../../utils/canvasMath.js';
import {
  buildTopicNavigationList,
  findTopicNavigationTarget,
  getTopicNavigationTopicKey,
  getTopicNavigationCardKey,
} from '../../domain/topicNavigation.js';

/**
 * Phase machine for the one-time "opening view" setup.
 *
 * A reducer so effects advance phases via a stable `dispatch` rather than a
 * synchronous setState in an effect body. Guards make transitions idempotent:
 * an action only advances from its preceding phase, so a re-run never skips or
 * rewinds a step.
 * @param {string} phase Current opening-view phase.
 * @param {string} action Requested transition.
 */
function initialViewReducer(phase, action) {
  switch (action) {
    // User already touched the canvas (or a non-default level was active): skip.
    case 'skip':
      return phase === 'pending' ? 'done' : phase;
    // Phase 1 committed the leaf level.
    case 'level-set':
      return phase === 'pending' ? 'level-set' : phase;
    // Phase 2 committed the zoomed-out transform.
    case 'zoomed':
      return phase === 'level-set' ? 'zoomed' : phase;
    // Phase 3 selected the first topic.
    case 'done':
      return phase === 'zoomed' ? 'done' : phase;
    default:
      return phase;
  }
}

/**
 * Drives the one-time "opening view" setup: leaf-level rail, zoomed out enough
 * to see a few levels of cards at once, first topic's summary shown.
 *
 * Phased because each step needs the previous one committed and re-rendered
 * (e.g. leaf-level topic cards exist only after `selectedLevel` updates); one
 * effect closure would read stale values.
 *
 * @param {object} params
 * @param {Array<unknown>} params.topics
 * @param {Map<number, unknown>} params.sentenceMetrics
 * @param {number} params.maxLevel
 * @param {number} params.selectedLevel
 * @param {function(number): void} params.setSelectedLevel
 * @param {object} params.viewport
 * @param {function(): boolean} params.viewport.hasUserMoved
 * @param {function(): {scale: number, translate: {x: number, y: number}}} params.viewport.readTransform
 * @param {function(number, {x: number, y: number}): void} params.viewport.setTransformNow
 * @param {boolean} params.showSummaryMode
 * @param {Array<unknown>} params.summaryCards
 * @param {Array<unknown>} params.zoomAdjustedTopicCards
 * @param {Map<string, unknown>} params.summaryMetricsState
 * @param {function(unknown): void} params.panToTopic
 * @param {function({path: string, cardKey: string}): void} params.selectTopic
 * @returns {{isSettled: boolean}} `isSettled` once the machine has finished (or
 *   skipped) every phase, i.e. the canvas will not move itself again.
 */
export function useInitialView({
  topics,
  sentenceMetrics,
  maxLevel,
  selectedLevel,
  setSelectedLevel,
  viewport,
  showSummaryMode,
  summaryCards,
  zoomAdjustedTopicCards,
  summaryMetricsState,
  panToTopic,
  selectTopic,
}) {
  // Reads the live transform via the viewport handle, not render-state scale/translate.
  const { hasUserMoved, setTransformNow, readTransform } = viewport;
  const [initialViewPhase, dispatch] = useReducer(initialViewReducer, 'pending');

  // ── Opening view: leaf level, zoomed out ~3 clicks, first topic's summary ──
  // Phase 1: once measured, jump straight to the leaf level.
  useEffect(() => {
    if (initialViewPhase !== 'pending') return;
    // No topics: later phases would wait on cards that never exist. Retire the
    // machine so the opening overlay isn't held behind a dead phase.
    if (topics.length === 0) {
      dispatch('skip');
      return;
    }
    if (sentenceMetrics.size === 0) return;
    // User touched the canvas while this settled; don't yank their view.
    if (hasUserMoved() || selectedLevel !== 0) {
      dispatch('skip');
      return;
    }
    if (maxLevel > 0) {
      setSelectedLevel(maxLevel);
    }
    dispatch('level-set');
  }, [
    initialViewPhase,
    topics,
    sentenceMetrics,
    maxLevel,
    selectedLevel,
    setSelectedLevel,
    hasUserMoved,
  ]);

  // Phase 2: once the leaf level commits, zoom out 3 "-" clicks so a few levels fit.
  useEffect(() => {
    if (initialViewPhase !== 'level-set') return;
    if (maxLevel > 0 && selectedLevel !== maxLevel) return;
    const { scale, translate } = readTransform();
    setTransformNow(clampScale(scale / 1.2 ** 3), translate);
    dispatch('zoomed');
  }, [initialViewPhase, selectedLevel, maxLevel, setTransformNow, readTransform]);

  // Phase 3: select the first topic (as "First topic" does) so its summary shows.
  useEffect(() => {
    if (initialViewPhase !== 'zoomed') return;
    const list = buildTopicNavigationList({
      showSummaryMode,
      summaryCards,
      topicCards: zoomAdjustedTopicCards,
      selectedLevel,
    });
    const targetCard = findTopicNavigationTarget({
      list,
      selectedNavigationKey: null,
      selectedTopicKey: null,
      direction: 'first',
      currentY: 0,
      showSummaryMode,
      summaryMetricsState,
    });
    if (targetCard) {
      selectTopic({
        path: getTopicNavigationTopicKey(targetCard, showSummaryMode),
        cardKey: getTopicNavigationCardKey(targetCard),
      });
      panToTopic(targetCard);
    }
    dispatch('done');
  }, [
    initialViewPhase,
    showSummaryMode,
    summaryCards,
    zoomAdjustedTopicCards,
    selectedLevel,
    summaryMetricsState,
    panToTopic,
    selectTopic,
  ]);

  return { isSettled: initialViewPhase === 'done' };
}
