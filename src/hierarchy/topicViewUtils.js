/**
 * Pure path and summary utilities shared by TopicHierarchyView.
 */

export function normalizeTopicPath(path) {
  return String(path || "")
    .split(">")
    .map((part) => part.trim())
    .filter(Boolean)
    .join(">");
}

export function spacedTopicPath(path) {
  return normalizeTopicPath(path).split(">").filter(Boolean).join(" > ");
}

export function getSummaryText(summary) {
  if (!summary) return "";
  if (typeof summary === "string") return summary.trim();
  if (typeof summary !== "object") return "";

  const text = typeof summary.text === "string" ? summary.text.trim() : "";
  const bullets = Array.isArray(summary.bullets)
    ? summary.bullets
        .filter((bullet) => typeof bullet === "string" && bullet.trim())
        .map((bullet) => bullet.trim())
    : [];

  return [text, ...bullets].filter(Boolean).join(" ");
}

/**
 * Build a lookup Map from normalised topic path to summary text.
 * Both `topicSummaries` and `topicSummaryIndex` are processed; later entries
 * for the same path overwrite earlier ones.
 *
 * @param {object|null} topicSummaries
 * @param {object|null} topicSummaryIndex
 * @returns {Map<string, string>}
 */
export function buildSummaryLookup(topicSummaries, topicSummaryIndex) {
  const lookup = new Map();
  const addSummary = (path, summary) => {
    const text = getSummaryText(summary);
    const normalizedPath = normalizeTopicPath(path);
    if (!text || !normalizedPath) return;
    lookup.set(normalizedPath, text);
    lookup.set(spacedTopicPath(normalizedPath), text);
  };

  if (topicSummaries && typeof topicSummaries === "object") {
    Object.entries(topicSummaries).forEach(([path, summary]) => addSummary(path, summary));
  }

  if (topicSummaryIndex && typeof topicSummaryIndex === "object") {
    Object.entries(topicSummaryIndex).forEach(([path, summary]) => addSummary(path, summary));
  }

  return lookup;
}
