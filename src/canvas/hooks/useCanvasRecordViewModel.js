import { projectArticleView } from '../../domain/articleView.js';
import { useMemo } from 'react';
import { sanitizeArticleHtml } from '../../highlights/articleHtml.js';
import { buildSummaryCards, filterSummaryCardsByLevel } from '../../domain/summaryCards.js';
import { buildTopicSentenceIndex, getMaxTopicLevel } from '../../domain/topicDomain.js';
import { useStableJsonValue } from '../../shared/hooks/useStableJsonValue.js';

/**
 * Derives the canvas's data from a storage record. Records are replaced often, so
 * identities are preserved for unchanged article data.
 * @param {object} input
 * @param {object} [input.record]
 * @param {number} input.selectedLevel
 * @param {boolean} input.showSummaryModeRaw
 */
export function useCanvasRecordViewModel({ record, selectedLevel, showSummaryModeRaw }) {
  const article = projectArticleView(record);

  // Reuse snapshots by content (also covers older records without a contentRevision).
  const topics = useStableJsonValue(article.topics);
  const sentences = useStableJsonValue(article.sentences);
  const topicSentenceIndex = useMemo(() => buildTopicSentenceIndex(topics), [topics]);
  const contentRevision =
    typeof record?.contentRevision === 'string' && record.contentRevision
      ? record.contentRevision
      : undefined;

  // sourceUrl resolves relative image/link URLs; otherwise they'd hit the extension origin and 404.
  const articleHtml = useMemo(() => {
    const html = record?.html;
    return html ? sanitizeArticleHtml(html, record?.sourceUrl) : '';
  }, [record?.html, record?.sourceUrl]);

  const maxLevel = useMemo(() => getMaxTopicLevel(topics), [topics]);
  const summaryIndex = useStableJsonValue(record?.topic_summary_index || null);
  const allSummaryCards = useMemo(() => buildSummaryCards(summaryIndex), [summaryIndex]);
  const summaryCards = useMemo(
    () => filterSummaryCardsByLevel(allSummaryCards, selectedLevel),
    [allSummaryCards, selectedLevel],
  );

  const summariesDisabled = record?.summariesDisabled === true;
  // Derived so a live update disabling summaries exits summary mode without an effect.
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
