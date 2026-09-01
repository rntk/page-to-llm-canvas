const SELECTED_ELEMENT_CLASS = 'pagetollm-selected';
const HIGHLIGHTED_ELEMENT_CLASS = 'pagetollm-element-highlight';
const SELECTED_ELEMENT_SELECTOR = `.${SELECTED_ELEMENT_CLASS}`;
export const HIGHLIGHTED_ELEMENT_SELECTOR = `.${HIGHLIGHTED_ELEMENT_CLASS}`;

export const SELECTION_MARKER_CLASSES = Object.freeze([
  SELECTED_ELEMENT_CLASS,
  HIGHLIGHTED_ELEMENT_CLASS,
]);

export const SELECTION_MARKER_SELECTOR = [
  SELECTED_ELEMENT_SELECTOR,
  HIGHLIGHTED_ELEMENT_SELECTOR,
].join(', ');

export function isElementSelected(element) {
  return Boolean(element?.classList?.contains(SELECTED_ELEMENT_CLASS));
}

export function setElementSelected(element, selected) {
  element?.classList?.toggle(SELECTED_ELEMENT_CLASS, selected);
}

export function setElementHighlighted(element, highlighted) {
  element?.classList?.toggle(HIGHLIGHTED_ELEMENT_CLASS, highlighted);
}
