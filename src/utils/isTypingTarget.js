/**
 * Whether a keyboard event's target is somewhere the reader is typing, and so
 * off limits for the canvas' global shortcuts (arrows pan, Backspace jumps
 * back). Shared by every `window` keydown listener so the guard cannot drift
 * between them.
 *
 * @param {EventTarget|null|undefined} target
 * @returns {boolean}
 */
export function isTypingTarget(target) {
  const tag = target?.tagName;
  return (
    tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || Boolean(target?.isContentEditable)
  );
}
