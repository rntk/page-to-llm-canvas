import { projectArticleView } from '../../domain/articleView.js';
import { useMemo } from 'react';
import { sanitizeArticleHtml } from '../../highlights/articleHtml.js';
import { buildSummaryCards, filterSummaryCardsByLevel } from '../../domain/summaryCards.js';
import { buildTopicSentenceIndex, getMaxTopicLevel } from '../../domain/topicDomain.js';
import { useStableJsonValue } from '../../shared/hooks/useStableJsonValue.js';

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

  // Storage collections are immutable JSON values. Reuse snapshots by content,
  // including for older records that do not have a content revision.
  const topics = useStableJsonValue(article.topics);
  const sentences = useStableJsonValue(article.sentences);
  const topicSentenceIndex = useMemo(() => buildTopicSentenceIndex(topics), [topics]);
  const contentRevision =
    typeof record?.contentRevision === 'string' && record.contentRevision
      ? record.contentRevision
      : undefined;

  // The source URL resolves the article's relative image/link URLs; without it
  // they would resolve against the extension origin and 404.
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
