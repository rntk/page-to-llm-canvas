/** Whether a key event is an unmodified, unhandled canvas shortcut.
 * @param {KeyboardEvent} event
 * @returns {boolean}
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
