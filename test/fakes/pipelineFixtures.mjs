import { vi } from 'vitest';

/**
 * Shared runtime stand-in for pipeline stage tests.
 * @param {object} [overrides] Runtime properties to override.
 * @returns {object} A fresh stage runtime fake.
 */
export function makeRuntime(overrides = {}) {
  const topicSummaries = {};
  const sourceSummaryUnits = {};
  const runtime = {
    signal: undefined,
    preferContentLanguage: false,
    update: vi.fn(async () => undefined),
    log: vi.fn(async () => undefined),
    ...overrides,
  };

  runtime.checkpointTopicSummary ??= vi.fn(async (topicPath, summary) => {
    topicSummaries[topicPath] = summary;
    return runtime.update({ topic_summaries: { ...topicSummaries } });
  });
  runtime.checkpointSourceSummaryUnit ??= vi.fn(async (unit) => {
    sourceSummaryUnits[unit.unitId] = unit;
    return runtime.update({ source_summary_units: { ...sourceSummaryUnits } });
  });

  return runtime;
}

/**
 * Build the article-chat input shape with fresh collection defaults.
 * @param {object} [overrides] Article properties to override.
 * @returns {object} A fresh article fixture.
 */
export function makeArticle(overrides = {}) {
  return {
    history: [],
    sentences: [],
    highlightedRanges: [],
    ...overrides,
  };
}
