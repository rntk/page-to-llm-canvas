import { ROOT } from '../pipeline/summaryTreeModel.js';
import { tokenize } from '../search/tokenize.js';

// Ranked hits kept before paging, and the most one single article may take.
const MAX_SEARCH_HITS = 60;
const MAX_HITS_PER_ARTICLE = 3;
const MAX_SENTENCES_PER_HIT = 3;
const TITLE_WEIGHT = 3;
const SUMMARY_WEIGHT = 2;
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const SENTENCE_RANK_WEIGHTS = [1, 0.5, 0.25];

const STOPWORDS = new Set(
  'a an and are as at be but by for from has have in is it its of on or that the their this to was were which with'.split(
    ' ',
  ),
);

const terms = (text) => {
  const all = tokenize(text);
  const kept = all.filter((token) => !STOPWORDS.has(token));
  return kept.length ? kept : all;
};

/**
 * Small in-memory BM25 over pre-tokenized documents.
 * @param {string[][]} docs
 * @returns {{score: function(string[]): Map<number, number>}}
 */
function createBm25(docs) {
  const postings = new Map();
  let totalLength = 0;
  docs.forEach((tokens, index) => {
    totalLength += tokens.length;
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    for (const [token, count] of counts) {
      if (!postings.has(token)) postings.set(token, []);
      postings.get(token).push([index, count]);
    }
  });
  const average = totalLength / Math.max(1, docs.length) || 1;
  return {
    score(queryTerms) {
      const scores = new Map();
      for (const term of queryTerms) {
        const list = postings.get(term);
        if (!list) continue;
        const idf = Math.log(1 + (docs.length - list.length + 0.5) / (list.length + 0.5));
        for (const [index, tf] of list) {
          const norm = 1 - BM25_B + (BM25_B * docs[index].length) / average;
          const part = (idf * tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
          scores.set(index, (scores.get(index) || 0) + part);
        }
      }
      return scores;
    },
  };
}

function buildSearchIndex(model) {
  const nodes = model.reachable().filter((node) => node.kind !== ROOT);
  const titles = createBm25(nodes.map((node) => terms(node.title)));
  const summaries = createBm25(nodes.map((node) => terms(model.summaryOf(node))));

  // Each sentence is scored once and credited to the leaf nodes that hold it.
  const sentenceIds = [];
  const owners = new Map();
  nodes.forEach((node, index) => {
    if (!model.isLeaf(node)) return;
    for (const id of model.sentenceIds(node)) {
      if (!owners.has(id)) {
        owners.set(id, []);
        sentenceIds.push(id);
      }
      owners.get(id).push(index);
    }
  });
  const sentenceIndex = createBm25(sentenceIds.map((id) => terms(model.cite(id).text)));
  return { nodes, titles, summaries, sentenceIds, owners, sentenceIndex };
}

/**
 * Lazily index a tree model and rank matches independently of tool formatting.
 * @param {object} model Read-only project tree model.
 * @returns {function(string): object[]} Ranked nodes with scores, source hits and articles.
 */
export function createTopicSearch(model) {
  let index = null;
  return (query) => {
    const queryTerms = [...new Set(terms(query))];
    if (!queryTerms.length) throw new Error('query must contain at least one word to search for');
    index ??= buildSearchIndex(model);

    const titleScores = index.titles.score(queryTerms);
    const summaryScores = index.summaries.score(queryTerms);
    const matched = new Map();
    for (const [position, score] of index.sentenceIndex.score(queryTerms)) {
      const id = index.sentenceIds[position];
      for (const owner of index.owners.get(id)) {
        if (!matched.has(owner)) matched.set(owner, []);
        matched.get(owner).push({ id, score });
      }
    }

    const candidates = [];
    index.nodes.forEach((node, position) => {
      const hits = (matched.get(position) || []).sort((a, b) => b.score - a.score || a.id - b.id);
      const sentenceScore = hits
        .slice(0, SENTENCE_RANK_WEIGHTS.length)
        .reduce((sum, hit, rank) => sum + hit.score * SENTENCE_RANK_WEIGHTS[rank], 0);
      const score =
        TITLE_WEIGHT * (titleScores.get(position) || 0) +
        SUMMARY_WEIGHT * (summaryScores.get(position) || 0) +
        sentenceScore;
      if (score > 0) {
        candidates.push({
          node,
          position,
          score,
          hits: hits.slice(0, MAX_SENTENCES_PER_HIT),
          inSummary: summaryScores.has(position),
        });
      }
    });
    candidates.sort((a, b) => b.score - a.score || a.position - b.position);

    // One article's passages must not crowd out the other articles.
    const perArticle = new Map();
    const ranked = [];
    for (const candidate of candidates) {
      const articles = model.articlesOf(candidate.node);
      if (articles.length === 1) {
        const used = perArticle.get(articles[0].key) || 0;
        if (used >= MAX_HITS_PER_ARTICLE) continue;
        perArticle.set(articles[0].key, used + 1);
      }
      ranked.push({ ...candidate, articles });
      if (ranked.length >= MAX_SEARCH_HITS) break;
    }

    return ranked;
  };
}
