import { createElement, useMemo } from 'react';
import { SourceCardChatDrawer } from './SourceCardChatDrawer.jsx';
import { articlesFromMergedRows, describeSourceCard } from './sourceCardChat.js';

/**
 * Chat for the source cards of one topics tree, in the shape TopicsTreeCanvas
 * takes as `leafChat`. Descriptions are cached per card, so the drawer's props
 * stay stable while it is open.
 *
 * @param {object} options
 * @param {string[]} options.sentences Tree sentences.
 * @param {object|null} [options.sentenceSources] Set for merged trees (see describeSourceCard).
 * @param {object|null} [options.article] Explicit single-article chat metadata.
 * @param {object|null} [options.record] Single-article source record.
 * @param {string} [options.recordKey] Key of the single-article source record.
 * @param {object[]} [options.records] Merged trees: the articles merged.
 * @param {string} [options.projectId] Merged trees: owner of chats over text from several articles.
 * @param {object} [options.chatPorts] ArticleChat port overrides (tests).
 * @returns {{available: function(object): boolean, render: function(object, {onClose: function(): void, onHighlightLines?: function(string[], {focus: boolean}): void, onClearHighlights?: function(): void}): import('react').ReactNode}}
 */
export function useSourceCardChats({
  sentences,
  sentenceSources = null,
  article = null,
  record = null,
  recordKey,
  records,
  projectId,
  chatPorts,
}) {
  const key = record ? recordKey : null;
  const title = record?.title || record?.sourceTitle || record?.sourceUrl || '';
  const url = record?.sourceUrl || '';
  const contentRevision = record?.contentRevision;
  const recordArticle = useMemo(
    () => (key ? { key, title, url, contentRevision } : null),
    [key, title, url, contentRevision],
  );
  const chatArticle = article || recordArticle;
  return useMemo(() => {
    // A rebuilt or alternate tree can reuse a card key with different sentences.
    const cards = new WeakMap();
    let articles = null;
    const getArticles = () =>
      (articles ??= articlesFromMergedRows(sentences, sentenceSources, records));
    const describe = (node) => {
      // Expanding a branch copies display nodes while keeping their evidence arrays.
      const evidence = node.sections ?? node.sentences;
      if (!cards.has(evidence)) {
        cards.set(
          evidence,
          describeSourceCard({
            node,
            sentences,
            sentenceSources,
            article: chatArticle,
            records,
            getArticles,
            projectId,
          }),
        );
      }
      return cards.get(evidence);
    };
    return {
      available: (node) => describe(node) !== null,
      render: (node, { onClose, onHighlightLines, onClearHighlights }) => {
        const card = describe(node);
        return card
          ? createElement(SourceCardChatDrawer, {
              card,
              onClose,
              onHighlightLines,
              onClearHighlights,
              chatPorts,
            })
          : null;
      },
    };
  }, [sentences, sentenceSources, chatArticle, records, projectId, chatPorts]);
}
