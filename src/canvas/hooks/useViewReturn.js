import { isCanvasShortcutEvent } from '../../utils/isCanvasShortcutEvent.js';
import { useCallback, useEffect, useRef, useState } from 'react';

import { isTypingTarget } from '../../utils/isTypingTarget.js';

/**
 * A "jump back" memory for the canvas view.
 *
 * Remembers the pre-jump transform and mode; returning swaps the saved and
 * current views, so the same control toggles between them.
 *
 * @param {object} params
 * @param {object} params.viewport Canvas command handle (readTransform + restoreView).
 * @param {boolean} params.showSummaryMode Currently committed mode.
 * @param {function(boolean): void} params.setShowSummaryMode
 * @param {function(): void} params.skipNextAlignment Suppresses the alignment hook for a restore-driven mode switch.
 * @returns {{hasReturnPoint: boolean, captureReturnPoint: function(): void, returnToCapturedView: function(): void}}
 */
export function useViewReturn({
  viewport,
  showSummaryMode,
  setShowSummaryMode,
  skipNextAlignment,
}) {
  const { readTransform, restoreView } = viewport;
  // Capture in a ref; only hasReturnPoint needs to trigger a render.
  const snapshotRef = useRef(null);
  // Restore deferred until a mode switch mounts its content (as zoom-to-sentence does).
  const pendingRestoreRef = useRef(null);
  const [hasReturnPoint, setHasReturnPoint] = useState(false);
  // A ref preserves callback identity and captures the committed mode.
  const showSummaryModeRef = useRef(showSummaryMode);
  useEffect(() => {
    showSummaryModeRef.current = showSummaryMode;
  }, [showSummaryMode]);

  const readCurrentView = useCallback(
    () => ({ ...readTransform(), showSummaryMode: showSummaryModeRef.current }),
    [readTransform],
  );

  const captureReturnPoint = useCallback(() => {
    snapshotRef.current = readCurrentView();
    setHasReturnPoint(true);
  }, [readCurrentView]);

  const returnToCapturedView = useCallback(() => {
    const target = snapshotRef.current;
    if (!target) return;
    // Swap first: whatever we are leaving becomes the way back.
    snapshotRef.current = readCurrentView();

    if (target.showSummaryMode !== showSummaryModeRef.current) {
      // The restore owns positioning; keep the alignment hook from gliding on top of it.
      skipNextAlignment();
      pendingRestoreRef.current = target;
      setShowSummaryMode(target.showSummaryMode);
      return;
    }
    restoreView(target);
  }, [readCurrentView, restoreView, setShowSummaryMode, skipNextAlignment]);

  // Deferred half of a cross-mode restore, once the target mode's content has mounted.
  useEffect(() => {
    const pending = pendingRestoreRef.current;
    if (!pending || pending.showSummaryMode !== showSummaryMode) return;
    pendingRestoreRef.current = null;
    restoreView(pending);
  }, [showSummaryMode, restoreView]);

  // Backspace is the keyboard way back; Escape (cancels selection/unlocks preview) and arrows (pan) are taken.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Backspace' || !isCanvasShortcutEvent(event)) return;
      if (isTypingTarget(event.target)) return;
      if (!snapshotRef.current) return;
      event.preventDefault();
      returnToCapturedView();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [returnToCapturedView]);

  return { hasReturnPoint, captureReturnPoint, returnToCapturedView };
}
