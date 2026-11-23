import { choice, decisionRequestFits } from '../llm/decisionClient.js';
import { PIPELINE_MIN_CONTEXT_WINDOW_TOKENS } from '../settings/llmBudgets.js';
import { throwIfCancelled } from './cancellation.js';
import { yesProbability } from './summaryTreeAnswers.js';
import { fitTextToChars } from './textFit.js';
import { MAX_TOPIC_TAGS } from './topicTagCloudConstants.js';

const MAX_CANDIDATES = 24;
const MAX_QUESTIONS = 8;
const MAX_SOURCE_CHARS = 1000;
const MIN_SHARED_SOURCE_CHARS = 250;
const OCCURRENCE_CONTEXT_CHARS = 64;
const RELEVANCE_THRESHOLD = 0.7;
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
const COMMON_WORDS = new Set(
  (
    'a an and are as at be been being but by can could did do does for from had has have ' +
    'he her his how i if in into is it its may me more most my no of on or our out s she ' +
    'so some than that the their them then there these they this those through to too up ' +
    'us was we were what when where which who will with would you your'
  ).split(' '),
);
const RELEVANCE_CRITERIA = {
  yes: 'The word identifies a specific subject, entity, or concept central to `topic_title` in `source_text`.',
  no: 'The word is generic, incidental to `topic_title`, or part of boilerplate in `source_text`.',
};

function selectCandidates(text) {
  const candidates = new Map();
  for (const { segment, index, isWordLike } of wordSegmenter.segment(text)) {
    if (!isWordLike || !/\p{L}/u.test(segment) || segment.length > 48) continue;
    const key = segment.normalize('NFC').toLowerCase();
    const isInitialism = /^\p{Lu}{2,}$/u.test(segment);
    // Common lowercase words can also be initialisms or proper names.
    if (COMMON_WORDS.has(key) && !isInitialism && segment !== 'May') continue;
    const previous = candidates.get(key);
    if (previous) {
      previous.count++;
    } else {
      candidates.set(key, { word: segment, index, count: 1 });
    }
  }
  return [...candidates.values()]
    .sort((left, right) => right.count - left.count)
    .slice(0, MAX_CANDIDATES);
}

function buildQuestions(text, candidates) {
  return Object.fromEntries(
    candidates.map(({ word, index }, slot) => [
      `word_${slot}`,
      choice(
        {
          question:
            'Would this word be an informative tag for the topic named by `topic_title`, given `source_text`?',
          word,
          occurrence: text.slice(
            Math.max(0, index - OCCURRENCE_CONTEXT_CHARS),
            index + word.length + OCCURRENCE_CONTEXT_CHARS,
          ),
        },
        RELEVANCE_CRITERIA,
      ),
    ]),
  );
}

function fitBatch(text, title, candidates, contextWindowTokens) {
  const state = { topic_title: fitTextToChars(title, 160), source_text: '' };
  let sourceChars = Math.min(MAX_SOURCE_CHARS, text.length);
  let batch = candidates;
  let questions = buildQuestions(text, batch);
  for (;;) {
    state.source_text = fitTextToChars(text, sourceChars);
    if (decisionRequestFits(state, questions, contextWindowTokens)) {
      return { state, questions, batch };
    }
    // Each question already has a local excerpt. Trim shared context before
    // removing questions, which would require additional calls.
    if (sourceChars > MIN_SHARED_SOURCE_CHARS) {
      sourceChars = Math.max(MIN_SHARED_SOURCE_CHARS, Math.floor(sourceChars / 2));
    } else if (batch.length > 1) {
      batch = batch.slice(0, -1);
      questions = buildQuestions(text, batch);
    } else if (sourceChars > 0) {
      sourceChars = Math.floor(sourceChars / 2);
    } else {
      throw new Error('Decision context window is too small to rank topic words');
    }
  }
}

/**
 * Rank terms selected from a leaf's source using independent relevance judgments.
 * @param {object} options Ranking inputs.
 * @param {string} options.text Source text for the leaf.
 * @param {string} [options.title] Leaf title used as topic context.
 * @param {Function} options.decide Decision request executor returning an answers envelope.
 * @param {AbortSignal} [options.signal] Caller cancellation.
 * @param {number} [options.contextWindowTokens] Configured provider context limit.
 * @returns {Promise<Array<{word: string, weight: number}>>} Relevant words, strongest first.
 */
export async function rankTopicWords({
  text,
  title,
  decide,
  signal,
  contextWindowTokens = PIPELINE_MIN_CONTEXT_WINDOW_TOKENS,
}) {
  const runtime = { signal };
  throwIfCancelled(runtime);
  const source = String(text ?? '');
  const candidates = selectCandidates(source);
  const ranked = [];
  for (let offset = 0; offset < candidates.length; ) {
    const { state, questions, batch } = fitBatch(
      source,
      title,
      candidates.slice(offset, offset + MAX_QUESTIONS),
      contextWindowTokens,
    );
    const response = await decide(state, questions, { signal });
    throwIfCancelled(runtime);
    batch.forEach(({ word }, slot) => {
      const probability = yesProbability(response?.answers, `word_${slot}`);
      if (probability === null)
        throw new Error(`Decision response is missing a valid score for "${word}"`);
      if (probability >= RELEVANCE_THRESHOLD) ranked.push({ word, weight: probability });
    });
    offset += batch.length;
  }
  return ranked.sort((left, right) => right.weight - left.weight).slice(0, MAX_TOPIC_TAGS);
}
