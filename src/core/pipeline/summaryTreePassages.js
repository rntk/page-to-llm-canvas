// Passages of a source article: contiguous runs of sentences, each the unit a
// brief summary is written for.

// A passage is the unit a brief summary is written for. Passages prefer the
// primary split's topic boundaries, so one passage rarely mixes subjects.
export const PASSAGE_TARGET_CHARS = 1500;
export const PASSAGE_MIN_CHARS = 400;
export const PASSAGE_MAX_CHARS = 3000;

function charsOf(sentenceIds, sentenceTexts) {
  return sentenceIds.reduce((sum, id) => sum + String(sentenceTexts[id - 1] || '').length + 1, 0);
}

// Near-equal character parts at sentence boundaries.
function splitRun(run, sentenceTexts, targetChars) {
  const total = charsOf(run, sentenceTexts);
  const count = Math.ceil(total / targetChars);
  if (count <= 1) return [run];
  const share = total / count;
  const parts = [[]];
  let size = 0;
  for (const id of run) {
    const chars = charsOf([id], sentenceTexts);
    if (parts.at(-1).length && size + chars / 2 > share * parts.length && parts.length < count) {
      parts.push([]);
    }
    parts.at(-1).push(id);
    size += chars;
  }
  return parts;
}

/**
 * Cut the article into contiguous passages of nonblank sentences. Cuts prefer
 * the primary topics' boundaries; long runs are split evenly and short pieces
 * join a neighbour.
 * @param {string[]} sentenceTexts Sentences by one-based number.
 * @param {Array<{name: string, sentences: number[]}>} [topics] Primary topics.
 * @param {object} [options]
 * @param {number} [options.targetChars]
 * @param {number} [options.minChars]
 * @param {number} [options.maxChars]
 * @returns {number[][]} One-based sentence numbers per passage, in article order.
 */
export function buildPassages(
  sentenceTexts,
  topics = [],
  {
    targetChars = PASSAGE_TARGET_CHARS,
    minChars = PASSAGE_MIN_CHARS,
    maxChars = PASSAGE_MAX_CHARS,
  } = {},
) {
  const topicOf = new Map();
  for (const topic of Array.isArray(topics) ? topics : []) {
    for (const id of Array.isArray(topic?.sentences) ? topic.sentences : []) {
      topicOf.set(id, topic.name);
    }
  }
  const runs = [];
  let previous;
  sentenceTexts.forEach((text, index) => {
    const id = index + 1;
    if (typeof text !== 'string' || !text.trim()) return;
    const topic = topicOf.get(id);
    if (!runs.length || topic !== previous) runs.push([]);
    runs.at(-1).push(id);
    previous = topic;
  });
  const pieces = runs.flatMap((run) =>
    charsOf(run, sentenceTexts) > maxChars ? splitRun(run, sentenceTexts, targetChars) : [run],
  );
  const passages = [];
  for (const piece of pieces) {
    const current = passages.at(-1);
    const currentChars = current ? charsOf(current, sentenceTexts) : 0;
    const pieceChars = charsOf(piece, sentenceTexts);
    if (
      current &&
      (currentChars < minChars || pieceChars < minChars) &&
      currentChars + pieceChars <= maxChars
    ) {
      current.push(...piece);
    } else {
      passages.push([...piece]);
    }
  }
  return passages;
}
