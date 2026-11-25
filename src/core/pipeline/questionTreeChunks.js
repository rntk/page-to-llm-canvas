// Chunks: contiguous runs of passages packed up to QUESTION_CHUNK_CHARS so
// each question-extraction request covers a coherent multi-passage window.

import { PASSAGE_MAX_CHARS, PASSAGE_TARGET_CHARS, buildPassages } from './summaryTreePassages.js';

export const QUESTION_CHUNK_CHARS = 6000;

function charsOf(sentenceIds, sentenceTexts) {
  return sentenceIds.reduce((sum, id) => sum + String(sentenceTexts[id - 1] || '').length + 1, 0);
}

function splitOversizedPassage(passage, sentenceTexts, limit) {
  if (passage.length <= 1 || charsOf(passage, sentenceTexts) <= limit) return [passage];
  const parts = [];
  let current = [];
  let currentChars = 0;
  for (const id of passage) {
    const idChars = charsOf([id], sentenceTexts);
    if (current.length && currentChars + idChars > limit) {
      parts.push(current);
      current = [id];
      currentChars = idChars;
    } else {
      current.push(id);
      currentChars += idChars;
    }
  }
  if (current.length) parts.push(current);
  return parts;
}

/**
 * Pack contiguous article passages into bounded chunks for question extraction.
 * @param {string[]} sentenceTexts Sentences by one-based number.
 * @param {Array<{name: string, sentences: number[]}>} [topics] Primary topics.
 * @param {object} [options]
 * @param {number} [options.maxChars]
 * @returns {Array<{id: string, sentences: number[]}>}
 */
export function buildQuestionChunks(
  sentenceTexts,
  topics = [],
  { maxChars = QUESTION_CHUNK_CHARS } = {},
) {
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? maxChars : QUESTION_CHUNK_CHARS;
  const passages = buildPassages(sentenceTexts, topics, {
    maxChars: Math.min(PASSAGE_MAX_CHARS, limit),
    targetChars: Math.min(PASSAGE_TARGET_CHARS, limit),
  }).flatMap((passage) => splitOversizedPassage(passage, sentenceTexts, limit));
  const chunks = [];
  let currentSentences = [];
  let currentChars = 0;

  for (const passage of passages) {
    const passageChars = charsOf(passage, sentenceTexts);
    if (currentSentences.length && currentChars + passageChars <= limit) {
      currentSentences.push(...passage);
      currentChars += passageChars;
    } else {
      if (currentSentences.length) {
        chunks.push({ id: `c${chunks.length + 1}`, sentences: currentSentences });
      }
      currentSentences = [...passage];
      currentChars = passageChars;
    }
  }
  if (currentSentences.length) {
    chunks.push({ id: `c${chunks.length + 1}`, sentences: currentSentences });
  }
  return chunks;
}
