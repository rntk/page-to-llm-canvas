import { projectArticleView } from '../../domain/articleView.js';
import { useMemo } from 'react';
import { sanitizeArticleHtml } from '../../highlights/articleHtml.js';
import { buildSummaryCards, filterSummaryCardsByLevel } from '../../domain/summaryCards.js';
import { buildTopicSentenceIndex, getMaxTopicLevel } from '../../domain/topicDomain.js';

/**
 * Normalize a storage record into the stable, derived data consumed by the
 * canvas. Storage updates replace the record object frequently, so this hook
 * deliberately preserves identities for article data that has not changed.
 * @param {object} input
 * @param {object} [input.record]
 * @param {number} input.selectedLevel
 * @param {boolean} input.showSummaryModeRaw
 */
export function useCanvasRecordViewModel({ record, selectedLevel, showSummaryModeRaw }) {
  const article = projectArticleView(record);

  // Serialize on record changes; downstream memos ignore equivalent topics.
  const topicsJson = useMemo(() => JSON.stringify(record?.topics || null), [record?.topics]);
  const topics = useMemo(
    () => article.topics,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topicsJson],
  );
  const topicSentenceIndex = useMemo(() => buildTopicSentenceIndex(topics), [topics]);

  // Sentence count and revision identify content. Revision distinguishes
  // reanalysis with the same count, keeping chat evidence paired with its text.
  const sentenceCount = article.sentences.length;
  const recordContentRevision =
    typeof record?.contentRevision === 'string' && record.contentRevision
      ? record.contentRevision
      : undefined;
  const sentenceSource = useMemo(
    () => ({
      sentences: article.sentences,
      contentRevision: recordContentRevision,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sentenceCount, recordContentRevision],
  );
  const { sentences, contentRevision } = sentenceSource;

  // The source URL resolves the article's relative image/link URLs; without it
  // they would resolve against the extension origin and 404.
  const articleHtml = useMemo(() => {
    const html = record?.html;
    return html ? sanitizeArticleHtml(html, record?.sourceUrl) : '';
  }, [record?.html, record?.sourceUrl]);

  const maxLevel = useMemo(() => getMaxTopicLevel(topics), [topics]);
  const summaryIndexJson = useMemo(
    () => JSON.stringify(record?.topic_summary_index || null),
    [record?.topic_summary_index],
  );
  const allSummaryCards = useMemo(
    () => buildSummaryCards(record?.topic_summary_index),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [summaryIndexJson],
  );
  const summaryCards = useMemo(
    () => filterSummaryCardsByLevel(allSummaryCards, selectedLevel),
    [allSummaryCards, selectedLevel],
  );

  const summariesDisabled = record?.summariesDisabled === true;
  // Keep this derived so a live record update disabling summaries exits summary
  // mode immediately, without waiting for an effect to reset local state.
  const showSummaryMode = showSummaryModeRaw && !summariesDisabled;
  return {
    topics,
    topicSentenceIndex,
    sentences,
    contentRevision,
    articleHtml,
    maxLevel,
    allSummaryCards,
    summaryCards,
    summariesDisabled,
    showSummaryMode,
  };
}
