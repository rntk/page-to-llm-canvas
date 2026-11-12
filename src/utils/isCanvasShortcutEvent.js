/** Return whether a keyboard event is available for an unmodified canvas shortcut.
 * @param {KeyboardEvent} event Keyboard event to inspect.
 * @returns {boolean} Whether the canvas can handle the event.
 */
export function isCanvasShortcutEvent(event) {
  return !(
    event.defaultPrevented ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  );
}
