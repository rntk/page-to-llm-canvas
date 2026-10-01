import { useCallback, useEffect, useRef, useState } from 'react';

import { isTypingTarget } from '../../utils/isTypingTarget.js';

/**
 * A "jump back" memory for the canvas view.
 *
 * Remember the pre-jump transform and mode. Returning swaps the saved and
 * current views, so the same control moves between them.
 *
 * @param {object} params
 * @param {object} params.viewport Imperative canvas handle (transform refs + setTransformNow).
 * @param {boolean} params.showSummaryMode Currently committed mode.
 * @param {function(boolean): void} params.setShowSummaryMode
 * @param {function(): void} params.skipNextAlignment Suppresses the alignment hook for a restore-driven mode switch.
 * @param {function(): void} params.flashFocus
 * @returns {{hasReturnPoint: boolean, captureReturnPoint: function(): void, returnToCapturedView: function(): void}}
 */
export function useViewReturn({
  viewport,
  showSummaryMode,
  setShowSummaryMode,
  skipNextAlignment,
  flashFocus,
}) {
  const { scaleRef, translateRef, setTransformNow, userMovedCanvasRef, flashZoomingToTarget } =
    viewport;
  // Capture in a ref; only hasReturnPoint needs to trigger a render.
  const snapshotRef = useRef(null);
  // A restore that has to wait for a mode switch to mount its content before the
  // transform means anything. Same deferral the zoom-to-sentence path uses.
  const pendingRestoreRef = useRef(null);
  const [hasReturnPoint, setHasReturnPoint] = useState(false);
  // A ref preserves callback identity and captures the committed mode.
  const showSummaryModeRef = useRef(showSummaryMode);
  useEffect(() => {
    showSummaryModeRef.current = showSummaryMode;
  }, [showSummaryMode]);

  const readCurrentView = useCallback(
    () => ({
      scale: scaleRef.current || 1,
      translate: { ...translateRef.current },
      showSummaryMode: showSummaryModeRef.current,
    }),
    [scaleRef, translateRef],
  );

  const captureReturnPoint = useCallback(() => {
    snapshotRef.current = readCurrentView();
    setHasReturnPoint(true);
  }, [readCurrentView]);

  const applyView = useCallback(
    (view) => {
      userMovedCanvasRef.current = true;
      // The restore animates the transform (flashFocus turns on the 320ms
      // transition) while scaleRef already holds the target scale — the same
      // window zoomToTarget suppresses sentence measurement for, since rects
      // measured mid-animation would be divided by the final scale. The flag's
      // false-flip is also what schedules the post-settle pass.
      flashZoomingToTarget();
      setTransformNow(view.scale, view.translate);
      flashFocus();
    },
    [setTransformNow, flashFocus, userMovedCanvasRef, flashZoomingToTarget],
  );

  const returnToCapturedView = useCallback(() => {
    const target = snapshotRef.current;
    if (!target) return;
    // Swap first: whatever we are leaving becomes the way back.
    snapshotRef.current = readCurrentView();

    if (target.showSummaryMode !== showSummaryModeRef.current) {
      // The restore owns positioning across the mode switch, so keep the
      // alignment hook from gliding the column a frame later on top of it.
      skipNextAlignment();
      pendingRestoreRef.current = target;
      setShowSummaryMode(target.showSummaryMode);
      return;
    }
    applyView(target);
  }, [applyView, readCurrentView, setShowSummaryMode, skipNextAlignment]);

  // Deferred half of a cross-mode restore: run once the target mode's content
  // has actually mounted, so the transform lands on the layout it was taken in.
  useEffect(() => {
    const pending = pendingRestoreRef.current;
    if (!pending || pending.showSummaryMode !== showSummaryMode) return;
    pendingRestoreRef.current = null;
    applyView(pending);
  }, [showSummaryMode, applyView]);

  // Backspace is the keyboard way back. Escape is already spoken for (it cancels
  // topic selection and unlocks a summary preview), and the arrows pan.
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== 'Backspace') return;
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
