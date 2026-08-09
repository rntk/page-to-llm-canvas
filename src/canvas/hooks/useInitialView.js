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
 * Modelled as a reducer (rather than a plain state setter) so the phase-
 * advancing transitions the effects below dispatch happen through `dispatch` —
 * a stable, non-render-cascading update — instead of a synchronous setState in
 * an effect body. The guards keep every transition idempotent: an action only
 * advances from the phase that legitimately precedes it, so a re-run of an
 * effect can never skip or rewind a step.
 * @param {string} phase Current opening-view phase.
 * @param {string} action Requested transition.
 */
function initialViewReducer(phase, action) {
  switch (action) {
    // The user already touched the canvas (panned/zoomed/switched level) — or a
    // non-default level was active — before the opening view could run: skip it.
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
 * Split into phases (rather than one effect) because each step depends on state
 * set by the previous one having actually committed and re-rendered (e.g. the
 * topic cards for the leaf level only exist after `selectedLevel` itself has
 * updated) — a single effect closure would read stale values.
 *
 * @param {object} params
 * @param {Array<unknown>} params.topics
 * @param {Map<number, unknown>} params.sentenceMetrics
 * @param {number} params.maxLevel
 * @param {number} params.selectedLevel
 * @param {function(number): void} params.setSelectedLevel
 * @param {object} params.viewport
 * @param {object} params.viewport.userMovedCanvasRef
 * @param {object} params.viewport.scaleRef
 * @param {object} params.viewport.translateRef
 * @param {function(number, {x: number, y: number}): void} params.viewport.setTransformNow
 * @param {boolean} params.showSummaryMode
 * @param {Array<unknown>} params.summaryCards
 * @param {Array<unknown>} params.zoomAdjustedTopicCards
 * @param {Map<string, unknown>} params.summaryMetricsState
 * @param {function(unknown): void} params.panToTopic
 * @param {function(?string): void} params.setSelectedTopicKey
 * @param {function(?string): void} params.setSelectedTopicCardKey
 * @returns {void}
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
  setSelectedTopicKey,
  setSelectedTopicCardKey,
}) {
  // The opening view only reads the live transform and moves it once, so it takes
  // the imperative viewport handle rather than the render-state scale/translate.
  const { userMovedCanvasRef, setTransformNow, scaleRef, translateRef } = viewport;
  const [initialViewPhase, dispatch] = useReducer(initialViewReducer, 'pending');

  // ── Opening view: leaf level, zoomed out ~3 clicks, first topic's summary ──
  // Phase 1: once the article and its topic hierarchy are measured, jump the
  // level switcher straight to the leaf level (mirrors clicking it manually).
  useEffect(() => {
    if (initialViewPhase !== 'pending') return;
    if (topics.length === 0 || sentenceMetrics.size === 0) return;
    // The user already touched the canvas (panned/zoomed/switched level) while
    // this settled — don't yank their view out from under them.
    if (userMovedCanvasRef.current || selectedLevel !== 0) {
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
    userMovedCanvasRef,
  ]);

  // Phase 2: once the leaf level has actually committed, zoom out the
  // equivalent of 3 "-" clicks so a few levels of cards fit on screen.
  useEffect(() => {
    if (initialViewPhase !== 'level-set') return;
    if (maxLevel > 0 && selectedLevel !== maxLevel) return;
    setTransformNow(clampScale((scaleRef.current || 1) / 1.2 ** 3), translateRef.current);
    dispatch('zoomed');
  }, [initialViewPhase, selectedLevel, maxLevel, setTransformNow, scaleRef, translateRef]);

  // Phase 3: with the leaf-level cards and zoom settled, select the first
  // topic — same as clicking "First topic" once — so its summary is visible.
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
      setSelectedTopicKey(getTopicNavigationTopicKey(targetCard, showSummaryMode));
      setSelectedTopicCardKey(getTopicNavigationCardKey(targetCard, showSummaryMode));
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
    setSelectedTopicKey,
    setSelectedTopicCardKey,
  ]);
}
