/**
 * Choose an immediate scroll when the viewer prefers reduced motion.
 * @param {Window} [view] Window whose motion preference applies.
 * @returns {string} Scroll behavior.
 */
export function scrollBehavior(view = globalThis.window) {
  return view?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth';
}
