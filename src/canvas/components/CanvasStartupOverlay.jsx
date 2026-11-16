import React from 'react';

/**
 * Opaque cover over the canvas while it measures and stages its opening view.
 * Matches the canvas surface (including the dot grid) so the reveal reads as a fade-through.
 *
 * Swallows mouse presses: a drag on the unseen canvas would count as a user move
 * and cancel the opening view.
 *
 * @param {object} props
 * @param {number} props.progress Completion in the 0..1 range.
 * @param {string} props.label Current step, shown above the bar.
 * @param {boolean} [props.isLeaving] Fades the overlay out.
 * @returns {JSX.Element}
 */
const CanvasStartupOverlay = React.memo(function CanvasStartupOverlay({
  progress,
  label,
  isLeaving = false,
}) {
  const percent = Math.round(Math.min(Math.max(progress, 0), 1) * 100);
  return (
    <div
      className={`canvas-startup${isLeaving ? ' is-leaving' : ''}`}
      onPointerDown={(event) => event.stopPropagation()}
      // Hidden while leaving: the live view is already behind it; don't announce a departing bar.
      aria-hidden={isLeaving ? 'true' : undefined}
    >
      <div className="canvas-startup__panel" role="status" aria-live="polite">
        <span className="canvas-startup__label">{label}</span>
        <div
          className="canvas-startup__track"
          role="progressbar"
          aria-label="Preparing canvas"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div className="canvas-startup__bar" style={{ width: `${percent}%` }} />
        </div>
      </div>
    </div>
  );
});

export default CanvasStartupOverlay;
