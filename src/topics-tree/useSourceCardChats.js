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
 * @param {object|null} [options.article] Set for single-article trees.
 * @param {object[]} [options.records] Merged trees: the articles merged.
 * @param {string} [options.projectId] Merged trees: owner of chats over text from several articles.
 * @param {object} [options.chatPorts] ArticleChat port overrides (tests).
 * @returns {{available: function(object): boolean, render: function(object, {onClose: function(): void}): import('react').ReactNode}}
 */
export function useSourceCardChats({
  sentences,
  sentenceSources = null,
  article = null,
  records,
  projectId,
  chatPorts,
}) {
  return useMemo(() => {
    const cards = new Map();
    let articles = null;
    const getArticles = () => (articles ??= articlesFromMergedRows(sentences, sentenceSources));
    const describe = (node) => {
      if (!cards.has(node.key)) {
        cards.set(
          node.key,
          describeSourceCard({
            node,
            sentences,
            sentenceSources,
            article,
            records,
            getArticles,
            projectId,
          }),
        );
      }
      return cards.get(node.key);
    };
    return {
      available: (node) => describe(node) !== null,
      render: (node, { onClose }) => {
        const card = describe(node);
        return card ? createElement(SourceCardChatDrawer, { card, onClose, chatPorts }) : null;
      },
    };
  }, [sentences, sentenceSources, article, records, projectId, chatPorts]);
}
