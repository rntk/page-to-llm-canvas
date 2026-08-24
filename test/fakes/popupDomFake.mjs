/**
 * The element ids `popup.js` resolves at module scope.
 *
 * The popup grabs these with `getElementById` and attaches listeners
 * immediately, so a spec that imports `popup.js` without them throws at import
 * time. Keeping one list here means adding an element to `popup.html` is a
 * single-line change instead of an edit duplicated across every popup spec.
 */
export const POPUP_ELEMENT_IDS = [
  'pick-btn',
  'refresh-btn',
  'theme-btn',
  'open-options',
  'open-records',
  'active-host',
  'records',
  'empty',
  'error',
  'record-count',
];

/** Ids that `popup.html` renders as buttons rather than containers. */
const POPUP_BUTTON_IDS = new Set([
  'pick-btn',
  'refresh-btn',
  'theme-btn',
  'open-options',
  'open-records',
]);

/**
 * Replaces the document body with the stub elements `popup.js` expects.
 *
 * @returns {void}
 */
export function installPopupDom() {
  document.body.replaceChildren();
  for (const id of POPUP_ELEMENT_IDS) {
    const element = document.createElement(POPUP_BUTTON_IDS.has(id) ? 'button' : 'div');
    element.id = id;
    document.body.appendChild(element);
  }
}
