import { MAX_TAGGED_CHARS, TOPIC_RANGE_INPUT_MAX_SENTENCES } from './pipelineConfig.js';

export function chunkTaggedText(tagged, maxChars) {
  const lines = tagged.split('\n').map((line) => fitTextToChars(line, maxChars));
  const chunks = [];
  let cur = [];
  let curLen = 0;
  for (const line of lines) {
    const lineLen = line.length + 1;
    if (curLen + lineLen > maxChars && cur.length > 0) {
      chunks.push(cur.join('\n'));
      cur = [];
      curLen = 0;
    }
    cur.push(line);
    curLen += lineLen;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

function fitTextToChars(text, maxChars) {
  const value = String(text || '');
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return value.slice(0, maxChars);
  const separator = '…';
  const retained = maxChars - separator.length;
  const headLength = Math.ceil(retained / 2);
  return `${value.slice(0, headLength)}${separator}${value.slice(value.length - (retained - headLength))}`;
}

function taggedSentenceLine(localIndex, sentence, maxChars) {
  const prefix = `{${localIndex}} `;
  if (prefix.length >= maxChars) return prefix.slice(0, maxChars);
  return `${prefix}${fitTextToChars(sentence, maxChars - prefix.length)}`;
}

/**
 * Build independently parseable topic-range inputs. Marker IDs intentionally
 * restart at zero in each chunk so the parser can validate and repair coverage
 * against that chunk alone. `start` maps the local IDs back to the article.
 * @param {string[]|object[]} sentences Source sentences.
 * @param {number} [maxChars] Maximum chunk size.
 * @param {number} [maxSentences] Maximum sentences per chunk.
 */
export function chunkTopicRangeSentences(
  sentences,
  maxChars = MAX_TAGGED_CHARS,
  maxSentences = TOPIC_RANGE_INPUT_MAX_SENTENCES,
) {
  if (!Array.isArray(sentences) || sentences.length === 0) return [];
  if (!Number.isFinite(maxChars) || maxChars <= 0) throw new Error('maxChars must be positive');
  if (!Number.isInteger(maxSentences) || maxSentences <= 0) {
    throw new Error('maxSentences must be a positive integer');
  }

  const chunks = [];
  let start = 0;
  while (start < sentences.length) {
    const lines = [];
    let length = 0;
    while (start + lines.length < sentences.length && lines.length < maxSentences) {
      const value = sentences[start + lines.length];
      const sentence = typeof value === 'string' ? value : value?.text;
      // One pathological sentence (minified data, a data URL, etc.) must not
      // defeat the request budget. Topic ranging only needs enough of that
      // indivisible sentence to label it, so preserve both its head and tail.
      const line = taggedSentenceLine(lines.length, sentence ?? '', maxChars);
      const addedLength = line.length + (lines.length > 0 ? 1 : 0);
      if (lines.length > 0 && length + addedLength > maxChars) break;
      lines.push(line);
      length += addedLength;
    }

    const sentenceCount = lines.length;
    chunks.push({ start, sentenceCount, tagged: lines.join('\n') });
    start += sentenceCount;
  }
  return chunks;
}
