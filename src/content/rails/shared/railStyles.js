// The rail's internal CSS ships with the lazily loaded rail chunk instead of
// the manifest's content_scripts stylesheets, so pages that never open a rail
// never parse it. Imported as strings (`?inline`) rather than as side-effecting
// CSS imports: a content script has no bundler-managed document to inject into,
// and we want the sheet's lifetime tied to the rail surface.
import contentRailCss from '../../../extension/styles/content-rail.css?inline';
import chatCss from '../../../extension/styles/chat.css?inline';

export const RAIL_STYLE_ELEMENT_ID = 'pagetollm-rail-styles';

// Concatenated in the order the manifest used to declare them, so the rail
// rules keep winning over the chat defaults they were written to override.
const RAIL_STYLES = `${chatCss}\n${contentRailCss}`;

/**
 * Add the rail stylesheet to a document, once.
 *
 * @param {Document} contentDocument Document hosting the rail.
 */
export function ensureRailStyles(contentDocument) {
  if (!contentDocument) return;
  if (contentDocument.getElementById(RAIL_STYLE_ELEMENT_ID)) return;
  const parent = contentDocument.head ?? contentDocument.documentElement;
  if (!parent) return;
  const style = contentDocument.createElement('style');
  style.id = RAIL_STYLE_ELEMENT_ID;
  // A host page style-src does not apply here: content scripts run in an
  // isolated world, and both engines exempt style nodes a content script
  // inserts. Keep this as textContent — Firefox propagates the extension
  // principal through textContent but not through innerText, which is the one
  // way to lose the exemption (bugzilla 1415352, 1822067). For the same reason
  // the sheet must stay free of url()/@font-face/@import: subresources it
  // references are still fetched under the page CSP.
  style.textContent = RAIL_STYLES;
  parent.appendChild(style);
}

/**
 * Remove the rail stylesheet once no rail is left to style.
 *
 * @param {Document} contentDocument Document hosting the rail.
 */
export function removeRailStyles(contentDocument) {
  contentDocument?.getElementById(RAIL_STYLE_ELEMENT_ID)?.remove();
}
