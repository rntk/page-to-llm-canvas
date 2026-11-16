import { useCallback, useState } from 'react';

/**
 * A topic's stable path and the particular card representing it.
 *
 * `cardKey` may be `null` (cards without a key); the target then matches by path alone.
 *
 * @typedef {{ path: string, cardKey: ?string }} TopicTarget
 */

/**
 * Copies a topic target so callers can't mutate state through it. Valid if it has
 * a path; a missing or non-string `cardKey` becomes `null`.
 *
 * @param {unknown} target
 * @returns {?TopicTarget}
 */
function copyTopicTarget(target) {
  if (!target || typeof target !== 'object' || typeof target.path !== 'string') {
    return null;
  }
  return {
    path: target.path,
    cardKey: typeof target.cardKey === 'string' ? target.cardKey : null,
  };
}

/**
 * Exact identity: both fields agree.
 *
 * @param {?TopicTarget} first
 * @param {?TopicTarget} second
 * @returns {boolean}
 */
function isSameTopicTarget(first, second) {
  return first?.path === second?.path && first?.cardKey === second?.cardKey;
}

/**
 * Whether `leavingTarget` refers to the topic currently hovered.
 *
 * Matches on path alone on purpose: hover is written by both the summary view
 * and the rail, whose card keys come from separate builders. Requiring keys to
 * agree would let a hover latch until an unrelated enter replaced it.
 *
 * @param {?TopicTarget} currentTarget
 * @param {?TopicTarget} leavingTarget
 * @returns {boolean}
 */
function matchesTopicTarget(currentTarget, leavingTarget) {
  if (!currentTarget || !leavingTarget) return false;
  return currentTarget.path === leavingTarget.path;
}

/**
 * Keeps the previous object when unchanged so React's `Object.is` bail-out applies
 * (`copyTopicTarget` always mints a new object).
 *
 * @param {?TopicTarget} currentTarget
 * @param {?TopicTarget} nextTarget
 * @returns {?TopicTarget}
 */
function preserveIdentity(currentTarget, nextTarget) {
  return isSameTopicTarget(currentTarget, nextTarget) ? currentTarget : nextTarget;
}

/** Owns the related hover, selection, and hierarchy-level state for topics. */
export function useTopicSelection() {
  const [selectedTarget, setSelectedTarget] = useState(null);
  const [hoveredTarget, setHoveredTarget] = useState(null);
  const [selectedLevel, setSelectedLevel] = useState(0);

  const enterTopic = useCallback((target) => {
    const nextTarget = copyTopicTarget(target);
    if (!nextTarget) return;
    setHoveredTarget((currentTarget) => preserveIdentity(currentTarget, nextTarget));
  }, []);

  const leaveTopic = useCallback((target) => {
    const leavingTarget = copyTopicTarget(target);
    if (!leavingTarget) return;
    setHoveredTarget((currentTarget) =>
      matchesTopicTarget(currentTarget, leavingTarget) ? null : currentTarget,
    );
  }, []);

  const toggleTopic = useCallback((target) => {
    const nextTarget = copyTopicTarget(target);
    if (!nextTarget) return;
    setSelectedTarget((currentTarget) =>
      isSameTopicTarget(currentTarget, nextTarget) ? null : nextTarget,
    );
  }, []);

  const selectTopic = useCallback((target) => {
    const nextTarget = copyTopicTarget(target);
    if (!nextTarget) return;
    setSelectedTarget((currentTarget) => preserveIdentity(currentTarget, nextTarget));
  }, []);

  const clearSelection = useCallback(() => {
    setSelectedTarget(null);
    setHoveredTarget(null);
  }, []);

  return {
    selectedTarget,
    hoveredTarget,
    activeTarget: hoveredTarget || selectedTarget,
    selectedLevel,
    setSelectedLevel,
    enterTopic,
    leaveTopic,
    toggleTopic,
    selectTopic,
    clearSelection,
  };
}
