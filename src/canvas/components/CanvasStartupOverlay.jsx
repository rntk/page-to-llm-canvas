import React from 'react';

/**
 * Opaque cover shown over the canvas while it measures and stages its opening
 * view. It matches the canvas surface (including the dot grid) so the reveal
 * reads as the content fading up through it rather than a panel being removed.
 *
 * It also swallows mouse presses while visible: starting a drag on a canvas the
 * user cannot see would be read as "the user moved the canvas" and cancel the
 * opening view halfway through.
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
      onMouseDown={(event) => event.stopPropagation()}
      // aria-hidden while leaving: the content behind it is already the live
      // view, and a departing progress bar should not be announced.
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
