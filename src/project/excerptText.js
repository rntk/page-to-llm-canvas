import { normalizeCapturedText } from '../core/pipeline/capturedText.js';
import { splitSentences } from '../core/pipeline/sentenceSplitter.js';

/**
 * @param {string} text Excerpt text.
 * @returns {string[]} The excerpt as the one-based sentences chat cites.
 */
export function excerptSentences(text) {
  const sentences = splitSentences(normalizeCapturedText(text)).map((sentence) => sentence.text);
  return sentences.length ? sentences : [String(text || '').trim()].filter(Boolean);
}
