import {
  projectBlockChatKey,
  sourceBlockChatKey,
  sourceCardChatKey,
} from '../core/storage/keys.js';
import { formatTopicPath, splitTopicPath } from '../shared/runtime/topicPath.js';
import { groupSentenceSources, passageKey } from './topicsTreeModel.js';

/**
 * @typedef {object} SourceCardChat
 * @property {string} chatKey Storage key of the card's own chat history.
 * @property {string} title Title of the article the card quotes.
 * @property {string} url URL of that article.
 * @property {string} [contentRevision] Revision of the article the card was read from.
 * @property {string[]} cardSentences The card's lines, in article order.
 * @property {string[]} lineKeys The passage (see passageKey) shown by each chat line.
 * @property {string[]} pageSentences The whole article, one-based by sentence number.
 */

/**
 * @typedef {object} SourceBlockChat
 * @property {string} chatKey Storage key of the block's own chat history.
 * @property {string} topic Path of the topic whose text the block shows.
 * @property {string} [contentRevision] Revision of the article, when the block quotes just one.
 * @property {string[]} cardSentences The block's lines in reading order, each section
 *   and page introduced by a "###" heading line.
 * @property {Array<string|null>} lineKeys The passage (see passageKey) shown by each chat
 *   line; null for heading lines.
 * @property {Array<{title: string, url: string, excerptSentences: string[], pageSentences: string[]}>} pages
 *   The pages quoted, numbered by position (1-based) in the headings and tools.
 */

/**
 * "3-5, 9" for [3, 4, 5, 9].
 * @param {number[]} numbers
 * @returns {string}
 */
function lineRanges(numbers) {
  const sorted = [...new Set(numbers)].sort((a, b) => a - b);
  const ranges = [];
  for (const number of sorted) {
    const last = ranges.at(-1);
    if (last && number === last[1] + 1) last[1] = number;
    else ranges.push([number, number]);
  }
  return ranges.map(([from, to]) => (from === to ? String(from) : `${from}-${to}`)).join(', ');
}

/**
 * The chat of a topic's whole source text: every section (one per sub-topic)
 * and every page it quotes, with headings so the model can tell them apart.
 */
function describeSourceBlock({
  node,
  sentences,
  sentenceSources,
  article,
  records,
  getArticles,
  projectId,
}) {
  const pages = new Map();
  const lines = [];
  const lineKeys = [];
  const localNumbers = [];
  for (const [index, section] of node.sections.entries()) {
    const groups = groupSentenceSources(section.sentences, sentenceSources);
    for (const group of groups) {
      const recordKey = sentenceSources ? group.source?.recordKey : article?.key;
      const meta = sentenceSources
        ? { ...group.source, ...records.find((candidate) => candidate.key === recordKey) }
        : article;
      const pageSentences = sentenceSources ? getArticles?.().get(recordKey) : sentences;
      const numbers = group.sentences.map((row) => row.sourceNumber);
      if (!recordKey || !pageSentences?.length || !numbers.every(Number.isInteger)) return null;
      if (!pages.has(recordKey)) {
        pages.set(recordKey, {
          recordKey,
          title: meta.title || '',
          url: meta.url || '',
          contentRevision: meta.contentRevision,
          excerptSentences: [],
          pageSentences,
        });
      }
      const page = pages.get(recordKey);
      const quoted = group.sentences
        .map((row) => ({
          number: row.number,
          text: String(sentences[row.number - 1] ?? '').trim(),
        }))
        .filter((row) => row.text);
      const texts = quoted.map((row) => row.text);
      if (!texts.length) continue;
      page.excerptSentences.push(...texts);
      localNumbers.push(...numbers.map((number) => ({ recordKey, number })));
      const pageNumber = [...pages.keys()].indexOf(recordKey) + 1;
      const topic = formatTopicPath(splitTopicPath(section.path));
      lines.push(
        `### Section ${index + 1} - topic: ${topic || 'whole article'} - page ${pageNumber} - page lines ${lineRanges(numbers)}`,
        ...texts,
      );
      lineKeys.push(null, ...quoted.map((row) => passageKey(section.key, row.number)));
    }
  }
  if (!pages.size || lines.length === 0) return null;

  const owner = pages.size === 1 ? [...pages.values()][0] : null;
  const chatKey = owner
    ? sourceBlockChatKey(
        owner.recordKey,
        localNumbers.map((entry) => entry.number),
      )
    : projectBlockChatKey(projectId, node.sentences);
  if (!chatKey) return null;
  return {
    chatKey,
    topic: formatTopicPath(splitTopicPath(node.path)),
    ...(owner?.contentRevision ? { contentRevision: owner.contentRevision } : {}),
    cardSentences: lines,
    lineKeys,
    pages: [...pages.values()].map(({ title, url, excerptSentences, pageSentences }) => ({
      title,
      url,
      excerptSentences,
      pageSentences,
    })),
  };
}

/**
 * Whole articles of a merged tree, rebuilt from the latest source rows.
 * Each version appends a contiguous article, so row minus sentenceId identifies
 * its offset. Earlier offsets can remain after incremental replacements.
 * @param {string[]} sentences Merged rows (one-based by row number).
 * @param {Record<number, {recordKey?: string, sentenceId?: number}>} sources
 * @returns {Map<string, string[]>} Article sentences by record key.
 */
export function articlesFromMergedRows(sentences, sources) {
  const articles = new Map();
  const offsets = new Map();
  for (const [row, source] of Object.entries(sources || {})) {
    if (!source?.recordKey || !Number.isInteger(source.sentenceId) || source.sentenceId < 1) {
      continue;
    }
    const offset = Number(row) - source.sentenceId;
    const latestOffset = offsets.get(source.recordKey);
    if (latestOffset !== undefined && offset < latestOffset) continue;
    if (latestOffset === undefined || offset > latestOffset) {
      offsets.set(source.recordKey, offset);
      articles.set(source.recordKey, []);
    }
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
 * @param {string} [options.projectId] Merged trees: owner of chats spanning several articles.
 * @returns {SourceCardChat|SourceBlockChat|null} A source block (a node with
 *   `sections`) gets a SourceBlockChat, which may span several articles.
 */
export function describeSourceCard({
  node,
  sentences,
  sentenceSources = null,
  article = null,
  records = [],
  getArticles,
  projectId,
}) {
  if (Array.isArray(node?.sections)) {
    return describeSourceBlock({
      node,
      sentences,
      sentenceSources,
      article,
      records,
      getArticles,
      projectId,
    });
  }
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
  const quoted = numbers
    .map((number) => ({ number, text: String(sentences[number - 1] ?? '').trim() }))
    .filter((row) => row.text);
  const cardSentences = quoted.map((row) => row.text);
  if (!chatKey || !cardSentences.length) return null;
  return {
    chatKey,
    title: meta.title || '',
    url: meta.url || '',
    ...(meta.contentRevision ? { contentRevision: meta.contentRevision } : {}),
    cardSentences,
    lineKeys: quoted.map((row) => passageKey('', row.number)),
    pageSentences,
  };
}
