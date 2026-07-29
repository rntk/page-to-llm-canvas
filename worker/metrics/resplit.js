// Privacy-safe oversized-range re-split (resplitSegment) metrics. Never stores
// prompts, responses, article text, URLs, record keys, or topic labels — only
// spans, counts, and outcome tallies.
//
// Purpose: decide whether the resplit stage still earns its cost now that the
// topic-ranges input is capped at TOPIC_RANGE_INPUT_MAX_SENTENCES. Answering
// that needs a denominator, so a sample is recorded for EVERY
// refineOversizedRanges call, including runs where nothing was oversized.

export const RESPLIT_METRICS_KEY = 'pagetollm-resplit-metrics';
export const RESPLIT_METRICS_MAX_RECENT = 40;

/** Outcome of a single resplitSegment call. */
export const RESPLIT_OUTCOMES = {
  SUBDIVIDED: 'subdivided',
  ACCEPTED_SINGLE: 'acceptedSingle',
  WINDOW_FALLBACK: 'windowFallback',
  NO_PROGRESS: 'noProgress',
  ERROR: 'error',
};

const OUTCOME_KEYS = Object.values(RESPLIT_OUTCOMES);

// Upper bound of each bucket, by span in sentences. Only spans of OVERSIZED
// ranges are bucketed, so the first bucket starts just above the oversize
// threshold (TOPIC_RANGE_MAX_SENTENCES = 40); a <=40 bucket would read zero
// forever. `maxSpanObserved` covers the normal-range side.
const SPAN_BUCKETS = [
  { key: 'le60', max: 60 },
  { key: 'le80', max: 80 },
  { key: 'le120', max: 120 },
  { key: 'le240', max: 240 },
  { key: 'gt240', max: Infinity },
];

export const SPAN_BUCKET_KEYS = SPAN_BUCKETS.map((bucket) => bucket.key);

export function spanBucketKey(span) {
  const value = Math.max(0, Number(span) || 0);
  return (SPAN_BUCKETS.find((bucket) => value <= bucket.max) ?? SPAN_BUCKETS.at(-1)).key;
}

export function emptyResplitMetrics() {
  return {
    // Denominator: every refineOversizedRanges call, oversized or not.
    runCount: 0,
    // Runs that found at least one oversized range (resplit actually ran).
    runsWithOversize: 0,
    // Runs where resplit changed the grouping (the only runs it earned its cost).
    runsChanged: 0,
    // Stricter signal: runs that ended with MORE topic groups than they
    // started with. `changed` can be true while the count is unchanged, because
    // the window fallback subdivides a span whose windows all carry the same
    // label and groupsFromSegments then merges them back. Only a net gain is
    // proof the resplit stage produced a topic the pipeline would otherwise
    // have missed, so this is the counter the removal decision hinges on.
    runsWithGroupGain: 0,
    // Total oversized segments seen and resplitSegment invocations spent on
    // them; each invocation is at least one LLM request.
    oversizeSegmentCount: 0,
    resplitCallCount: 0,
    // Actual LLM requests issued by the resplit stage. Higher than
    // resplitCallCount whenever a range's tagged text exceeds MAX_TAGGED_CHARS
    // and fans out into several chunk requests. This is the cost figure; it
    // still excludes callLLMWithRetry's internal transport retries, so treat
    // it as a lower bound.
    llmRequestCount: 0,
    // Baseline for the figure above: LLM requests the PRIMARY topic-ranges
    // stage issued in the same runs. Resplit shares LLM_TASK_TYPES.TOPIC_RANGES
    // with that stage, so the general LLM metrics cannot separate the two and
    // this is the only place the "resplit added N% on top of baseline" ratio
    // is available. Also a lower bound: it excludes parse retries.
    primaryRequestCount: 0,
    maxSpanObserved: 0,
    outcomes: Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0])),
    // Spans of oversized segments only, at the moment they were detected.
    oversizeSpanBuckets: Object.fromEntries(SPAN_BUCKET_KEYS.map((key) => [key, 0])),
    recent: [],
  };
}

function nonNegative(value) {
  return Math.max(0, Number(value) || 0);
}

/** Blank per-run tally that the pipeline stage fills in as a resplit proceeds. */
export function createResplitRunStats() {
  return {
    segmentCount: 0,
    oversizeCount: 0,
    oversizeSpans: [],
    maxSpan: 0,
    resplitCallCount: 0,
    llmRequestCount: 0,
    primaryChunkCount: 0,
    outcomes: Object.fromEntries(OUTCOME_KEYS.map((key) => [key, 0])),
    changed: false,
    groupCountBefore: 0,
    groupCountAfter: 0,
  };
}

/** Tally one resplitSegment outcome onto a run's stats (no-op when unset). */
export function noteResplitOutcome(stats, outcome) {
  if (!stats || !OUTCOME_KEYS.includes(outcome)) return;
  stats.outcomes[outcome]++;
}

function normalizeRunSample(sample = {}) {
  const oversizeSpans = Array.isArray(sample.oversizeSpans)
    ? sample.oversizeSpans.map(nonNegative)
    : [];
  const outcomes = Object.fromEntries(
    OUTCOME_KEYS.map((key) => [key, nonNegative(sample.outcomes?.[key])]),
  );
  return {
    at: nonNegative(sample.at) || Date.now(),
    segmentCount: nonNegative(sample.segmentCount),
    oversizeCount: nonNegative(sample.oversizeCount) || oversizeSpans.length,
    maxSpan: Math.max(nonNegative(sample.maxSpan), ...oversizeSpans, 0),
    resplitCallCount: nonNegative(sample.resplitCallCount),
    llmRequestCount: nonNegative(sample.llmRequestCount),
    primaryChunkCount: nonNegative(sample.primaryChunkCount),
    changed: sample.changed === true,
    groupCountBefore: nonNegative(sample.groupCountBefore),
    groupCountAfter: nonNegative(sample.groupCountAfter),
    outcomes,
    oversizeSpans,
  };
}

export function normalizeResplitMetrics(value) {
  const empty = emptyResplitMetrics();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return empty;
  const outcomes = {};
  for (const key of OUTCOME_KEYS) outcomes[key] = nonNegative(value.outcomes?.[key]);
  const oversizeSpanBuckets = {};
  for (const key of SPAN_BUCKET_KEYS) {
    oversizeSpanBuckets[key] = nonNegative(value.oversizeSpanBuckets?.[key]);
  }
  const recent = Array.isArray(value.recent)
    ? value.recent.slice(0, RESPLIT_METRICS_MAX_RECENT).map((entry) => {
        const { oversizeSpans: _spans, ...normalized } = normalizeRunSample(entry);
        return normalized;
      })
    : [];
  return {
    runCount: nonNegative(value.runCount),
    runsWithOversize: nonNegative(value.runsWithOversize),
    runsChanged: nonNegative(value.runsChanged),
    runsWithGroupGain: nonNegative(value.runsWithGroupGain),
    oversizeSegmentCount: nonNegative(value.oversizeSegmentCount),
    resplitCallCount: nonNegative(value.resplitCallCount),
    llmRequestCount: nonNegative(value.llmRequestCount),
    primaryRequestCount: nonNegative(value.primaryRequestCount),
    maxSpanObserved: nonNegative(value.maxSpanObserved),
    outcomes,
    oversizeSpanBuckets,
    recent,
  };
}

// Serialized read-modify-write: resplits fan out through parallelMap and
// recurse, so unserialized chrome.storage.local updates would lose counts.
let writeChain = Promise.resolve();

function readRaw() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(RESPLIT_METRICS_KEY, (items) =>
        resolve(normalizeResplitMetrics(items?.[RESPLIT_METRICS_KEY])),
      );
    } catch (_) {
      resolve(emptyResplitMetrics());
    }
  });
}

export async function getResplitMetrics() {
  if (typeof chrome === 'undefined' || !chrome?.storage?.local) return emptyResplitMetrics();
  return readRaw();
}

/**
 * Record one refineOversizedRanges run. Call this for every run, including
 * runs with no oversized ranges — those are the denominator that makes the
 * "is resplit still needed?" question answerable.
 */
export function recordResplitRun(sample = {}) {
  writeChain = writeChain
    .then(async () => {
      if (typeof chrome === 'undefined' || !chrome?.storage?.local) return;
      const metrics = await readRaw();
      const run = normalizeRunSample(sample);

      metrics.runCount++;
      if (run.oversizeCount > 0) metrics.runsWithOversize++;
      if (run.changed) metrics.runsChanged++;
      if (run.groupCountAfter > run.groupCountBefore) metrics.runsWithGroupGain++;
      metrics.oversizeSegmentCount += run.oversizeCount;
      metrics.resplitCallCount += run.resplitCallCount;
      metrics.llmRequestCount += run.llmRequestCount;
      metrics.primaryRequestCount += run.primaryChunkCount;
      metrics.maxSpanObserved = Math.max(metrics.maxSpanObserved, run.maxSpan);
      for (const key of OUTCOME_KEYS) metrics.outcomes[key] += run.outcomes[key];
      for (const span of run.oversizeSpans) metrics.oversizeSpanBuckets[spanBucketKey(span)]++;

      const { oversizeSpans: _spans, ...entry } = run;
      metrics.recent.unshift(entry);
      metrics.recent = metrics.recent.slice(0, RESPLIT_METRICS_MAX_RECENT);
      await new Promise((resolve) =>
        chrome.storage.local.set({ [RESPLIT_METRICS_KEY]: metrics }, resolve),
      );
    })
    .catch((error) => console.warn('PageToLLM Canvas resplit metrics record failed:', error));
  return writeChain;
}

export function clearResplitMetrics() {
  writeChain = writeChain.then(
    () =>
      new Promise((resolve) => {
        try {
          chrome.storage.local.set({ [RESPLIT_METRICS_KEY]: emptyResplitMetrics() }, resolve);
        } catch (_) {
          resolve();
        }
      }),
  );
  return writeChain;
}
