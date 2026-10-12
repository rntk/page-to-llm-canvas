import { ARTICLE_CHAT_MAX_CHUNK_CHARS } from '../core/settings/llmBudgets.js';
import { splitTextToMaxChars } from '../core/llm/textChunking.js';

// Numbered chunks preserve global highlight lines across requests.
export const ARTICLE_CHAT_CHUNK_MAX_CHARS = ARTICLE_CHAT_MAX_CHUNK_CHARS;

/**
 * Split an article into bounded, numbered contexts. Oversized sentences share
 * their original line number across parts so highlight references remain valid.
 * Omitted sentences consume no budget; lineNumbers records gaps for validation.
 *
 * @param {Array<string>} sentences Article sentences in display order.
 * @param {number} [maxChars] Maximum characters per chunk.
 * @returns {Array<{startLine: number, endLine: number, lineNumbers: number[], text: string}>}
 */
export function chunkNumberedArticle(sentences, maxChars = ARTICLE_CHAT_CHUNK_MAX_CHARS) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.floor(maxChars) : 1;
  const chunks = [];
  let lines = [];
  let lineNumbers = [];
  let length = 0;
  let startLine = null;
  let endLine = null;

  const flush = () => {
    if (!lines.length) return;
    chunks.push({ startLine, endLine, lineNumbers, text: lines.join('\n') });
    lines = [];
    lineNumbers = [];
    length = 0;
    startLine = null;
    endLine = null;
  };

  (Array.isArray(sentences) ? sentences : []).forEach((sentence, index) => {
    const value = String(sentence || '').trim();
    if (!value) return;
    const lineNumber = index + 1;
    const prefix = `${lineNumber}: `;
    if (limit <= prefix.length) {
      throw new Error(`maxChars must exceed the numbered line prefix (${prefix.length})`);
    }
    const partLimit = limit - prefix.length;
    const parts =
      prefix.length + value.length > limit
        ? splitTextToMaxChars(value, partLimit, { preserveWhitespace: true })
        : [value];
    parts.forEach((part, partIndex) => {
      const line = `${prefix}${part}`;
      const nextLength = length + (lines.length ? 1 : 0) + line.length;
      if (lines.length && nextLength > limit) flush();
      if (!lines.length) startLine = lineNumber;
      lines.push(line);
      if (lineNumbers.at(-1) !== lineNumber) lineNumbers.push(lineNumber);
      length += (length ? 1 : 0) + line.length;
      endLine = lineNumber;
      // A split source unit must remain independently bounded. Otherwise two
      // parts of the same original sentence can be joined back over the cap.
      if (partIndex < parts.length - 1) flush();
    });
  });
  flush();
  return chunks;
}
