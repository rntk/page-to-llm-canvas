// Shared fast-check configuration. Normal local runs intentionally keep a
// random seed so they explore new cases; failures print their seed and shrink
// path, which can be replayed with FC_SEED and FC_PATH.
import process from 'node:process';
import * as fc from 'fast-check';

function readSafeInteger(name, { fallback, positive = false } = {}) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;

  const value = Number(raw);
  if (!Number.isSafeInteger(value) || (positive && value <= 0)) {
    const expectation = positive ? 'a positive safe integer' : 'a safe integer';
    throw new Error(`${name} must be ${expectation}; received ${JSON.stringify(raw)}`);
  }
  return value;
}

const seed = readSafeInteger('FC_SEED');
const parameters = {
  numRuns: readSafeInteger('FC_NUM_RUNS', { fallback: 100, positive: true }),
};

if (seed !== undefined) parameters.seed = seed;
if (process.env.FC_PATH) {
  if (seed === undefined) {
    throw new Error('FC_PATH requires FC_SEED so the shrunk case can be replayed');
  }
  parameters.path = process.env.FC_PATH;
}

fc.configureGlobal(parameters);
