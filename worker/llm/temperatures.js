// Per-task sampling temperature configuration.
//
// Every provider entry may carry an optional temperature for each of the three
// task groups the extension issues requests for. A missing/empty value means
// "do not send the `temperature` parameter at all" — the provider's own default
// applies. That is the only workable setting for models that reject the
// parameter outright (OpenAI reasoning models answer such requests with a
// non-retryable HTTP 400).

import { LLM_TASK_TYPES } from '../../src/shared/runtime/telemetry.js';

/**
 * Canonical task groups a temperature can be configured for.
 * @readonly
 */
export const TemperatureTask = Object.freeze({
  SUMMARIES: 'summaries',
  CHAT: 'chat',
  SPLITTING: 'splitting',
});

export const TEMPERATURE_TASKS = Object.freeze(Object.values(TemperatureTask));

/** Options-page metadata for the three temperature fields. */
export const TEMPERATURE_TASK_DEFINITIONS = Object.freeze([
  Object.freeze({
    task: TemperatureTask.SUMMARIES,
    label: 'Summaries',
    hint: 'Article and topic summaries, including summary merges.',
  }),
  Object.freeze({
    task: TemperatureTask.CHAT,
    label: 'Chat',
    hint: 'Article chat answers and synthesis.',
  }),
  Object.freeze({
    task: TemperatureTask.SPLITTING,
    label: 'Splitting',
    hint: 'Topic range detection and resplits.',
  }),
]);

export const PROVIDER_MIN_TEMPERATURE = 0;
export const PROVIDER_MAX_TEMPERATURE = 2;

/** Maps a telemetry task type onto the task group it takes its temperature from. */
const TASK_TYPE_TO_TEMPERATURE_TASK = Object.freeze({
  [LLM_TASK_TYPES.ARTICLE_SUMMARY]: TemperatureTask.SUMMARIES,
  [LLM_TASK_TYPES.ARTICLE_SUMMARY_MERGE]: TemperatureTask.SUMMARIES,
  [LLM_TASK_TYPES.TOPIC_SUMMARY_FROM_SOURCE]: TemperatureTask.SUMMARIES,
  [LLM_TASK_TYPES.CHAT_ANSWER]: TemperatureTask.CHAT,
  [LLM_TASK_TYPES.CHAT_SYNTHESIS]: TemperatureTask.CHAT,
  [LLM_TASK_TYPES.TOPIC_RANGES]: TemperatureTask.SPLITTING,
});

/**
 * @param {unknown} taskType A telemetry task type (`LLM_TASK_TYPES`).
 * @returns {string|undefined} The task group, or undefined for unmapped types.
 */
export function temperatureTaskForTaskType(taskType) {
  if (typeof taskType !== 'string') return undefined;
  return TASK_TYPE_TO_TEMPERATURE_TASK[taskType];
}

/**
 * Validates and normalizes the per-task temperatures coming from the UI.
 * Empty strings, null and undefined all mean "unset" and are dropped, so an
 * unset field never reaches the provider request body. Returns undefined when
 * no field is set, keeping stored providers free of empty objects.
 *
 * @param {unknown} input
 * @returns {{summaries?: number, chat?: number, splitting?: number}|undefined}
 */
export function normalizeProviderTemperatures(input) {
  if (input == null) return undefined;
  if (typeof input !== 'object') {
    throw new Error('Temperatures must be an object');
  }
  const normalized = {};
  for (const task of TEMPERATURE_TASKS) {
    const value = normalizeTemperature(input[task], task);
    if (value !== undefined) normalized[task] = value;
  }
  return Object.keys(normalized).length ? normalized : undefined;
}

function normalizeTemperature(value, task) {
  if (value == null || String(value).trim() === '') return undefined;
  const parsed = Number(value);
  if (
    !Number.isFinite(parsed) ||
    parsed < PROVIDER_MIN_TEMPERATURE ||
    parsed > PROVIDER_MAX_TEMPERATURE
  ) {
    throw new Error(
      `Temperature (${task}) must be a number between ${PROVIDER_MIN_TEMPERATURE} and ${PROVIDER_MAX_TEMPERATURE}, or empty`,
    );
  }
  return parsed;
}

/**
 * Resolves the temperature to send for one request. Undefined means the
 * parameter is omitted from the request body.
 *
 * @param {{temperatures?: Record<string, number>}|null|undefined} provider
 * @param {unknown} taskType A telemetry task type (`LLM_TASK_TYPES`).
 * @returns {number|undefined}
 */
export function resolveProviderTemperature(provider, taskType) {
  const task = temperatureTaskForTaskType(taskType);
  if (!task) return undefined;
  const configured = provider?.temperatures?.[task];
  return typeof configured === 'number' && Number.isFinite(configured) ? configured : undefined;
}
