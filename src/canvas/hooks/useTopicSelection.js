import { useCallback, useState } from 'react';

/**
 * A topic's stable path and the particular card representing it.
 *
 * `cardKey` is optional: the navigation helpers in `domain/topicNavigation.js`
 * resolve it to `null` for cards that carry no key, and a target is still
 * usable in that state — it simply matches by path alone.
 *
 * @typedef {{ path: string, cardKey: ?string }} TopicTarget
 */

/**
 * Normalizes and copies a topic target so callers cannot mutate state through a
 * target object they still hold. A target is valid as long as it names a path;
 * a missing or non-string `cardKey` is narrowed to `null` rather than rejected.
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
 * Deliberately matches on path alone. Hover is written by two independent
 * components (the summary view and the hierarchy rail) whose card keys come
 * from separate builders, so requiring the keys to agree would mean a hover set
 * by one writer could only ever be released by that same writer — it would
 * otherwise latch until an unrelated enter replaced it. Two cards sharing a
 * path are the same topic, and the pointer leaves one before entering the next.
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
 * Keeps the previous object when the value is unchanged so React's `Object.is`
 * bail-out still applies. `copyTopicTarget` mints a fresh object on every call,
 * so without this a repeated hover would re-render every memoized consumer.
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
