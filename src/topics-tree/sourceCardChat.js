import { sourceCardChatKey } from '../core/storage/keys.js';
import { groupSentenceSources } from './topicsTreeModel.js';

/**
 * @typedef {object} SourceCardChat
 * @property {string} chatKey Storage key of the card's own chat history.
 * @property {string} title Title of the article the card quotes.
 * @property {string} url URL of that article.
 * @property {string} [contentRevision] Revision of the article the card was read from.
 * @property {string[]} cardSentences The card's lines, in article order.
 * @property {string[]} pageSentences The whole article, one-based by sentence number.
 */

/**
 * Whole articles of a merged tree, rebuilt from its source rows.
 * @param {string[]} sentences Merged rows (one-based by row number).
 * @param {Record<number, {recordKey?: string, sentenceId?: number}>} sources
 * @returns {Map<string, string[]>} Article sentences by record key.
 */
export function articlesFromMergedRows(sentences, sources) {
  const articles = new Map();
  for (const [row, source] of Object.entries(sources || {})) {
    if (!source?.recordKey || !Number.isInteger(source.sentenceId) || source.sentenceId < 1) {
      continue;
    }
    if (!articles.has(source.recordKey)) articles.set(source.recordKey, []);
    articles.get(source.recordKey)[source.sentenceId - 1] = sentences[Number(row) - 1] ?? '';
  }
  for (const article of articles.values()) {
    for (let index = 0; index < article.length; index += 1) article[index] ??= '';
  }
  return articles;
}

/**
 * What a source card's chat needs: the card's own lines as context, and the
 * whole article behind them for the model to read and search.
 *
 * A card shows one article's lines (passages never mix articles); a card that
 * somehow spans several has no chat, as no single article could be read for it.
 *
 * @param {object} options
 * @param {{sentences: number[]}} options.node The source (leaf) card.
 * @param {string[]} options.sentences Tree sentences (one-based by number).
 * @param {object|null} [options.sentenceSources] Merged trees: article and local
 *   line of each row. Null for a single article, whose lines are its own.
 * @param {{key: string, title?: string, url?: string, contentRevision?: string}|null} [options.article]
 *   The article of a single-article tree.
 * @param {object[]} [options.records] Merged trees: `{key, title, url, contentRevision}`.
 * @param {function(): Map<string, string[]>} [options.getArticles] Merged trees:
 *   whole articles by record key (see articlesFromMergedRows), built on demand.
 * @returns {SourceCardChat|null}
 */
export function describeSourceCard({
  node,
  sentences,
  sentenceSources = null,
  article = null,
  records = [],
  getArticles,
}) {
  const numbers = Array.isArray(node?.sentences) ? node.sentences : [];
  if (!numbers.length) return null;

  let recordKey;
  let meta;
  let localNumbers;
  let pageSentences;
  if (sentenceSources) {
    const groups = groupSentenceSources(numbers, sentenceSources);
    const source = groups.length === 1 ? groups[0].source : null;
    if (!source?.recordKey) return null;
    recordKey = source.recordKey;
    localNumbers = groups[0].sentences.map((row) => row.sourceNumber);
    pageSentences = getArticles?.().get(recordKey);
    meta = { ...source, ...records.find((candidate) => candidate.key === recordKey) };
  } else {
    if (!article?.key) return null;
    recordKey = article.key;
    localNumbers = numbers;
    pageSentences = sentences;
    meta = article;
  }
  if (!pageSentences?.length || !localNumbers.every(Number.isInteger)) return null;

  const chatKey = sourceCardChatKey(
    recordKey,
    Math.min(...localNumbers),
    Math.max(...localNumbers),
  );
  const cardSentences = numbers
    .map((number) => String(sentences[number - 1] ?? '').trim())
    .filter(Boolean);
  if (!chatKey || !cardSentences.length) return null;
  return {
    chatKey,
    title: meta.title || '',
    url: meta.url || '',
    ...(meta.contentRevision ? { contentRevision: meta.contentRevision } : {}),
    cardSentences,
    pageSentences,
  };
}
