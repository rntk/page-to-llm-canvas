import { useCallback, useEffect, useRef } from 'react';
import { clampScale, cursorAnchoredTranslate } from '../utils/canvasMath.js';
import { fitTransform } from './treeLayout.js';

// A pointer has to travel this far before a press on a topic turns into a pan
// (and its click is swallowed).
const PAN_THRESHOLD_PX = 4;
// Cards keep their own scrolling, text selection and dragging.
const NO_PAN_SELECTOR = '.tt-card, button, a, input, select, textarea, summary';
const NATIVE_WHEEL_SELECTOR = '.tt-card';

function wheelZoomFactor(event) {
  const unit = event.deltaMode === 1 ? 0.05 : event.deltaMode ? 1 : 0.002;
  return Math.pow(2, -event.deltaY * unit * (event.ctrlKey ? 5 : 1));
}

/**
 * Pan/zoom for the topics tree stage. The transform is applied straight to
 * the stage element (not React state), so panning never re-renders the tree.
 *
 * Drag empty space or a topic to pan; wheel zooms around the cursor. Over a
 * card the wheel scrolls the card unless Ctrl is held (pinch zoom also sends
 * Ctrl+wheel).
 */
export function useTreeViewport() {
  const canvasRef = useRef(null);
  const stageRef = useRef(null);
  const transformRef = useRef({ k: 1, x: 24, y: 24 });
  const suppressClickRef = useRef(false);

  const apply = useCallback((transform) => {
    transformRef.current = transform;
    const stage = stageRef.current;
    if (stage) {
      stage.style.transform = `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`;
    }
  }, []);

  /** Shift the view by a screen-space delta. */
  const translateBy = useCallback(
    (dx, dy) => {
      const { k, x, y } = transformRef.current;
      apply({ k, x: x + dx, y: y + dy });
    },
    [apply],
  );

  const fit = useCallback(
    (bounds) => {
      const canvas = canvasRef.current;
      const viewport = {
        width: canvas?.clientWidth || 800,
        height: canvas?.clientHeight || 600,
      };
      apply(fitTransform(bounds, viewport));
    },
    [apply],
  );

  const zoomAt = useCallback(
    (factor, cursor) => {
      const current = transformRef.current;
      const k = clampScale(current.k * factor);
      const { x, y } = cursorAnchoredTranslate({
        cursor,
        translate: current,
        currentScale: current.k,
        nextScale: k,
      });
      apply({ k, x, y });
    },
    [apply],
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let pan = null;

    const onWheel = (event) => {
      if (!event.ctrlKey && event.target?.closest?.(NATIVE_WHEEL_SELECTOR)) return;
      event.preventDefault();
      const rect = canvas.getBoundingClientRect();
      zoomAt(wheelZoomFactor(event), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };

    const onPointerMove = (event) => {
      if (!pan) return;
      const dx = event.clientX - pan.x;
      const dy = event.clientY - pan.y;
      if (!pan.moved && Math.hypot(dx, dy) < PAN_THRESHOLD_PX) return;
      if (!pan.moved) {
        pan.moved = true;
        canvas.classList.add('is-panning');
      }
      pan.x = event.clientX;
      pan.y = event.clientY;
      translateBy(dx, dy);
    };

    const endPan = () => {
      if (pan?.moved) suppressClickRef.current = true;
      pan = null;
      canvas.classList.remove('is-panning');
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', endPan);
      window.removeEventListener('pointercancel', endPan);
    };

    const onPointerDown = (event) => {
      if (event.button !== 0 || event.target?.closest?.(NO_PAN_SELECTOR)) return;
      suppressClickRef.current = false;
      pan = { x: event.clientX, y: event.clientY, moved: false };
      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', endPan);
      window.addEventListener('pointercancel', endPan);
    };

    // A pan that started on a topic must not also toggle it on release.
    const onClickCapture = (event) => {
      if (!suppressClickRef.current) return;
      suppressClickRef.current = false;
      event.stopPropagation();
      event.preventDefault();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('click', onClickCapture, true);
    apply(transformRef.current);
    return () => {
      endPan();
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('click', onClickCapture, true);
    };
  }, [apply, translateBy, zoomAt]);

  return { canvasRef, stageRef, transformRef, translateBy, fit, zoomAt };
}
