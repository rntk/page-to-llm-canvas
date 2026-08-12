import { SOURCE_SUMMARY_MAX_CHARS } from './pipelineConfig.js';
import { makeSourceSummarizer } from './sourceSummarizer.js';
import { markProviderFailure } from './providerFailure.js';

export const SOURCE_SUMMARY_INPUT_VERSION = 'source-summary-v1';
export const SOURCE_SUMMARY_MERGE_INPUT_VERSION = 'source-summary-merge-v1';
export const LEAF_SUMMARY_INPUT_VERSION = 'leaf-summary-v1';
export const LEAF_SUMMARY_MERGE_INPUT_VERSION = 'leaf-summary-merge-v1';

function normalizeContentRevision(value) {
  const revision = typeof value === 'string' ? value.trim() : '';
  return revision || null;
}

function normalizeInputFingerprint(value) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return 'default-settings';
}

// Deterministic and realm-neutral because Chrome storage may be read by a
// later service-worker instance.
function fingerprint(value) {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const text = String(value);
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 0x01000193);
    second ^= code + index;
    second = Math.imul(second, 0x85ebca6b);
  }
  return `${text.length.toString(16)}-${(first >>> 0).toString(16)}-${(second >>> 0).toString(16)}`;
}

/**
 * Returns the compact storage key for one source-summary provider request.
 * The full run remains in the unit body for validation/debugging, while the
 * property name uses its fingerprint to avoid multi-kilobyte storage keys.
 *
 * @param {object} input
 * @param {'single'|'chunk'|'merge'} input.kind
 * @param {string} [input.path]
 * @param {number[]} input.runSentences
 * @param {number} input.startSentence
 * @param {number} input.endSentence
 * @returns {string}
 */
export function sourceSummaryUnitId({
  kind,
  path = '',
  runSentences,
  startSentence,
  endSentence,
  profile = 'topic',
  part,
}) {
  return JSON.stringify({
    stage: 'source_summary',
    ...(profile !== 'topic' ? { profile } : {}),
    kind,
    path: typeof path === 'string' ? path : '',
    run: fingerprint(JSON.stringify(Array.isArray(runSentences) ? runSentences : [])),
    start: startSentence,
    end: endSentence,
    ...(part !== undefined ? { part } : {}),
  });
}

/**
 * Computes the fingerprint used to validate a persisted source-summary unit.
 *
 * @param {object} input
 * @param {'single'|'chunk'|'merge'} input.kind
 * @param {string} input.source Exact input supplied to this provider request.
 * @param {boolean} input.preferContentLanguage
 * @param {string} [input.inputFingerprint]
 * @returns {string}
 */
export function sourceSummaryInputFingerprint({
  kind,
  source,
  preferContentLanguage,
  inputFingerprint,
  profile = 'topic',
  maxChars = SOURCE_SUMMARY_MAX_CHARS,
}) {
  const version =
    profile === 'leaf'
      ? kind === 'merge'
        ? LEAF_SUMMARY_MERGE_INPUT_VERSION
        : LEAF_SUMMARY_INPUT_VERSION
      : kind === 'merge'
        ? SOURCE_SUMMARY_MERGE_INPUT_VERSION
        : SOURCE_SUMMARY_INPUT_VERSION;
  return fingerprint(
    JSON.stringify({
      version,
      ...(profile !== 'topic' ? { profile } : {}),
      kind,
      source: String(source || ''),
      preferContentLanguage: preferContentLanguage === true,
      settings: normalizeInputFingerprint(inputFingerprint),
      maxChars,
    }),
  );
}

function reusableUnit(priorUnits, unitId, contentRevision, inputFingerprint) {
  if (!contentRevision || !priorUnits || typeof priorUnits !== 'object') return null;
  const prior = priorUnits[unitId];
  if (!prior || typeof prior !== 'object' || prior.status !== 'done') return null;
  if (prior.contentRevision !== contentRevision) return null;
  if (prior.inputFingerprint !== inputFingerprint) return null;
  return typeof prior.result === 'string' ? prior : null;
}

function sourceUnit(metadata, contentRevision, inputFingerprint, result) {
  const {
    kind,
    path,
    runSentences,
    startSentence,
    endSentence,
    profile = 'topic',
    part,
  } = metadata;
  const unitId = sourceSummaryUnitId(metadata);
  return {
    unitId,
    kind,
    ...(profile !== 'topic' ? { profile } : {}),
    path: typeof path === 'string' ? path : '',
    run: [...runSentences],
    start_sentence: startSentence,
    end_sentence: endSentence,
    ...(part !== undefined ? { part } : {}),
    contentRevision,
    inputFingerprint,
    status: 'done',
    result,
  };
}

/**
 * Adds durable request caching around the source summarizer. The summarizer
 * still owns prompt construction, chunking, and response parsing. This
 * wrapper resolves and persists provider units, and marks only rejections
 * from the actual provider call as retryable provider failures.
 *
 * @param {object} input
 * @returns {Function}
 */
export function makeCachedSourceSummarizer({
  sentenceTexts,
  limit,
  signal,
  preferContentLanguage = false,
  callLLMWithRetry,
  priorUnits = {},
  contentRevision,
  inputFingerprint,
  persistUnit,
  summaryMode = 'topic',
  maxChars = SOURCE_SUMMARY_MAX_CHARS,
}) {
  const currentContentRevision = normalizeContentRevision(contentRevision);
  const settingsFingerprint = normalizeInputFingerprint(inputFingerprint);

  const cachedCallLLMWithRetry = async (options, maxAttempts) => {
    const { sourceSummaryUnit: metadata, ...providerOptions } = options;
    const callProvider = async () => {
      try {
        return await callLLMWithRetry(providerOptions, maxAttempts);
      } catch (error) {
        throw markProviderFailure(error);
      }
    };
    if (!metadata || !currentContentRevision) {
      return await callProvider();
    }

    const requestFingerprint = sourceSummaryInputFingerprint({
      kind: metadata.kind,
      source: metadata.source,
      preferContentLanguage,
      inputFingerprint: settingsFingerprint,
      profile: metadata.profile || summaryMode,
      maxChars,
    });
    const unitId = sourceSummaryUnitId(metadata);
    const prior = reusableUnit(priorUnits, unitId, currentContentRevision, requestFingerprint);
    if (prior) return prior.result;

    const result = await callProvider();
    if (typeof result === 'string' && typeof persistUnit === 'function') {
      await persistUnit(sourceUnit(metadata, currentContentRevision, requestFingerprint, result));
    }
    return result;
  };

  return makeSourceSummarizer({
    sentenceTexts,
    limit,
    signal,
    preferContentLanguage,
    callLLMWithRetry: cachedCallLLMWithRetry,
    summaryMode,
    maxChars,
  });
}
