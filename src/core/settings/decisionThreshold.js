// Split threshold for the decision-API topic splitter: a sentence gap starts a
// new topic when the model's P(split) is at or above this value. Lower values
// produce more, smaller topics; higher values produce fewer, larger ones.

import { createStoredSetting } from '../../shared/runtime/localStore.js';

export const DECISION_SPLIT_THRESHOLD_KEY = 'pagetollm-decision-split-threshold';
export const DEFAULT_DECISION_SPLIT_THRESHOLD = 0.5;
export const MIN_DECISION_SPLIT_THRESHOLD = 0.05;
export const MAX_DECISION_SPLIT_THRESHOLD = 0.95;
export const DECISION_SPLIT_THRESHOLD_STEP = 0.05;

export function normalizeDecisionSplitThreshold(value) {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value));
  if (!Number.isFinite(parsed)) return DEFAULT_DECISION_SPLIT_THRESHOLD;
  const clamped = Math.min(
    MAX_DECISION_SPLIT_THRESHOLD,
    Math.max(MIN_DECISION_SPLIT_THRESHOLD, parsed),
  );
  return Math.round(clamped * 100) / 100;
}

const setting = createStoredSetting({
  key: DECISION_SPLIT_THRESHOLD_KEY,
  defaultValue: DEFAULT_DECISION_SPLIT_THRESHOLD,
  normalize: normalizeDecisionSplitThreshold,
});

export function getStoredDecisionSplitThreshold() {
  return setting.read();
}

export function setStoredDecisionSplitThreshold(value) {
  return setting.write(value);
}
