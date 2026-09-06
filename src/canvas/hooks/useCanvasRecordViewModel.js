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
  //
  // The content revision is part of that identity, and is published together
  // with the array it belongs to: a reanalysis that replaces the article with
  // different text of the same sentence count would otherwise leave the canvas
  // (and the chat answering from it) on the old sentences while the record
  // already reports the new revision. Consumers that pair the two — the chat
  // stamps each persisted turn with the revision its source came from — would
  // then label an old-source answer as belonging to the new content.
  const sentenceCount = Array.isArray(record?.sentences) ? record.sentences.length : 0;
  const recordContentRevision =
    typeof record?.contentRevision === 'string' && record.contentRevision
      ? record.contentRevision
      : undefined;
  const sentenceSource = useMemo(
    () => ({
      sentences: Array.isArray(record?.sentences) ? record.sentences : [],
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
