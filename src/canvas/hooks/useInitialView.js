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
 * @param {{
 *   isDone: boolean,
 *   topics: Array<unknown>,
 *   sentenceMetrics: Map<number, unknown>,
 *   maxLevel: number,
 *   selectedLevel: number,
 *   setSelectedLevel: (level: number) => void,
 *   viewport: {
 *     userMovedCanvasRef: import('react').RefObject<boolean>,
 *     scaleRef: import('react').RefObject<number>,
 *     translateRef: import('react').RefObject<{ x: number, y: number }>,
 *     setTransformNow: (scale: number, translate: { x: number, y: number }) => void,
 *   },
 *   showSummaryMode: boolean,
 *   summaryCards: Array<unknown>,
 *   zoomAdjustedTopicCards: Array<unknown>,
 *   summaryMetricsState: Map<string, unknown>,
 *   panToTopic: (card: unknown) => void,
 *   setSelectedTopicKey: (key: string | null) => void,
 *   setSelectedTopicCardKey: (key: string | null) => void,
 * }} params
 * @returns {void}
 */
export function useInitialView({
  isDone,
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
    if (!isDone || topics.length === 0 || sentenceMetrics.size === 0) return;
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
    isDone,
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
