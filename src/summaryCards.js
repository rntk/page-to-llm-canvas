import { splitTopicPath } from "./topicCards.js";

/**
 * Pure helper that turns record.topics + record.topic_summaries (legacy) or
 * record.topic_summary_index (preferred, hierarchical) into the
 * summaryViewCards[] array consumed by CanvasSummaryView.
 *
 * Card shape: { path, name, text, bullets, sourceSentences, startSentence, levelIndex }
 */
export function buildSummaryCards(topics, topicSummaries, topicSummaryIndex) {
  const index = topicSummaryIndex && typeof topicSummaryIndex === "object"
    ? topicSummaryIndex
    : null;

  if (index && Object.keys(index).length > 0) {
    const cards = [];
    for (const [rawPath, entry] of Object.entries(index)) {
      if (!rawPath) continue;
      const parts = splitTopicPath(rawPath);
      const path = parts.join(" > ") || rawPath;
      const name = parts[parts.length - 1] || path;
      const sourceSentences = Array.isArray(entry.source_sentences)
        ? entry.source_sentences
        : [];
      const startSentence = sourceSentences.length
        ? Math.min(...sourceSentences)
        : 0;
      cards.push({
        path,
        name,
        text: typeof entry.text === "string" ? entry.text : "",
        bullets: Array.isArray(entry.bullets) ? entry.bullets : [],
        sourceSentences,
        startSentence,
        levelIndex:
          typeof entry.level === "number" ? entry.level : parts.length - 1,
      });
    }
    cards.sort(
      (a, b) =>
        a.levelIndex - b.levelIndex ||
        a.startSentence - b.startSentence ||
        a.path.localeCompare(b.path),
    );
    return cards;
  }

  if (!Array.isArray(topics)) return [];
  const summaries = topicSummaries || {};

  const cards = [];
  for (const topic of topics) {
    const parts = splitTopicPath(topic.name);
    const path = parts.join(" > ") || topic.name;
    const name = parts[parts.length - 1] || path;

    const summary = summaries[topic.name] || summaries[path] || {};
    const text = typeof summary.text === "string" ? summary.text : "";
    const bullets = Array.isArray(summary.bullets) ? summary.bullets : [];
    const sourceSentences = Array.isArray(summary.source_sentences)
      ? summary.source_sentences
      : Array.isArray(topic.sentences)
        ? topic.sentences
        : [];
    const startSentence = sourceSentences.length
      ? Math.min(...sourceSentences)
      : Array.isArray(topic.sentences) && topic.sentences.length
        ? Math.min(...topic.sentences)
        : 0;

    cards.push({
      path,
      name,
      text,
      bullets,
      sourceSentences,
      startSentence,
      levelIndex: parts.length - 1,
    });
  }

  return cards;
}
