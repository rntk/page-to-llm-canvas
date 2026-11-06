import { findTextBlocks } from '../selection/findTextBlocks.js';
import { getRenderedText } from '../selection/html.js';

/**
 * Reads the page's rendered text for project canvas chat. Uses the picker's
 * Find detection to keep to the main long-read blocks, falling back to the
 * whole body when nothing qualifies. Captures text only; nothing is submitted.
 * @param {Document} document
 * @returns {Promise<string>}
 */
export async function capturePageText(document) {
  const window = document.defaultView;
  const detected = await findTextBlocks(document);
  const roots =
    detected.status === 'found' && detected.blocks.length
      ? detected.blocks.map((block) => block.element)
      : [document.body].filter(Boolean);
  const styleCache = new Map();
  return roots
    .map((root) => getRenderedText(root, window, Infinity, styleCache))
    .filter(Boolean)
    .join('\n');
}
