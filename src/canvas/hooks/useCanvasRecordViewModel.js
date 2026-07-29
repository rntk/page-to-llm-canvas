import { useMemo } from 'react';
import { sanitizeArticleHtml } from '../../highlights/articleHtml.js';
import { buildSummaryCards, filterSummaryCardsByLevel } from '../../domain/summaryCards.js';
import { buildTopicSentenceIndex, getMaxTopicLevel } from '../../domain/topicDomain.js';

/**
 * Normalize a storage record into the stable, derived data consumed by the
 * canvas. Storage updates replace the record object frequently, so this hook
 * deliberately preserves identities for article data that has not changed.
 */
export function useCanvasRecordViewModel({ record, error, selectedLevel, showSummaryModeRaw }) {
  // Serialize once per record change, not once per render. `record` is
  // referentially stable across UI interactions, while storage writes mint a
  // new object. Downstream memos can therefore ignore equivalent rewrites.
  const topicsJson = useMemo(() => JSON.stringify(record?.topics || null), [record?.topics]);
  const topics = useMemo(
    () => (Array.isArray(record?.topics) ? record.topics : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [topicsJson],
  );
  const topicSentenceIndex = useMemo(() => buildTopicSentenceIndex(topics), [topics]);

  // Sentences are immutable once extracted. Their count is used as the stable
  // identity key so unrelated processing-log and timestamp writes do not
  // rebuild DOM ranges, measurements, and highlights.
  const sentenceCount = Array.isArray(record?.sentences) ? record.sentences.length : 0;
  const sentences = useMemo(
    () => (Array.isArray(record?.sentences) ? record.sentences : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sentenceCount],
  );

  const articleHtml = useMemo(() => {
    const html = record?.html;
    return html ? sanitizeArticleHtml(html) : '';
  }, [record?.html]);

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

  const isDone = record?.status === 'done';
  const summariesDisabled = record?.summariesDisabled === true;
  // Keep this derived so a live record update disabling summaries exits summary
  // mode immediately, without waiting for an effect to reset local state.
  const showSummaryMode = showSummaryModeRaw && !summariesDisabled;
  const isNeedsAttention = record?.status === 'needs_attention';
  const isRecordError = record?.status === 'error' || record?.status === 'cancelled';
  const isMissing = !record && error === 'record not found';
  const isDeleted = !record && error === 'record deleted';
  const stage = record?.progress?.stage || record?.status || 'loading';

  return {
    topics,
    topicSentenceIndex,
    sentences,
    articleHtml,
    maxLevel,
    allSummaryCards,
    summaryCards,
    isDone,
    summariesDisabled,
    showSummaryMode,
    isNeedsAttention,
    isRecordError,
    isMissing,
    isDeleted,
    stage,
  };
}
