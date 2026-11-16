/**
 * Whether a keydown target is a text-entry control, which global canvas shortcuts
 * (arrow pan, Backspace) must ignore. Shared so every window keydown listener uses one guard.
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
