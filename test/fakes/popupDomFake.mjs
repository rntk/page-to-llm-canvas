/**
 * Element ids `popup.js` needs when imported by a test.
 */
const POPUP_ELEMENT_IDS = [
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

/** Ids rendered as buttons in `popup.html`. */
const POPUP_BUTTON_IDS = new Set([
  'pick-btn',
  'refresh-btn',
  'theme-btn',
  'open-options',
  'open-records',
]);

/**
 * Replaces the document body with the elements `popup.js` expects.
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
