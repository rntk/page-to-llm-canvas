/**
 * Follows a pointer gesture on the window until release.
 * @param {PointerEvent} start
 * @param {function(number, number): void} onMove Receives total dx, dy in px.
 * @param {function(): void} [onEnd] Called on pointerup/pointercancel, not on cancel.
 * @returns {function(): void} Cancel: stops tracking without calling `onEnd`.
 */
export function trackPointer(start, onMove, onEnd) {
  const { clientX: x0, clientY: y0 } = start;
  const handleMove = (event) => onMove(event.clientX - x0, event.clientY - y0);
  const stop = () => {
    window.removeEventListener('pointermove', handleMove);
    window.removeEventListener('pointerup', release);
    window.removeEventListener('pointercancel', release);
  };
  function release() {
    stop();
    onEnd?.();
  }
  window.addEventListener('pointermove', handleMove);
  window.addEventListener('pointerup', release);
  window.addEventListener('pointercancel', release);
  return stop;
}
