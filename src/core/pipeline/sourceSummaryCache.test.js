import { describe, expect, it, vi } from 'vitest';
import { makeCachedSourceSummarizer, sourceSummaryUnitId } from './sourceSummaryCache.js';

const source = 'word '.repeat(120).trim();

function makeSummarizer(callLLMWithRetry, options = {}) {
  return makeCachedSourceSummarizer({
    sentenceTexts: [source],
    limit: (work) => work(),
    callLLMWithRetry,
    ...options,
  });
}

describe('source summary cache', () => {
  it('reuses a completed unit only when revision and request inputs match', async () => {
    const persisted = [];
    const persistUnit = vi.fn(async (unit) => persisted.push(unit));
    const provider = vi.fn(async () => 'cached summary');
    const first = makeSummarizer(provider, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-a',
      persistUnit,
    });

    await expect(first([1], { path: 'Science>AI' })).resolves.toEqual({
      runs: [{ sentences: [1], text: 'cached summary' }],
    });
    expect(provider).toHaveBeenCalledTimes(1);
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      kind: 'single',
      path: 'Science>AI',
      contentRevision: 'rev-1',
      status: 'done',
      result: 'cached summary',
    });

    const cachedProvider = vi.fn();
    const cached = makeSummarizer(cachedProvider, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-a',
      priorUnits: { [persisted[0].unitId]: persisted[0] },
    });
    await expect(cached([1], { path: 'Science>AI' })).resolves.toEqual({
      runs: [{ sentences: [1], text: 'cached summary' }],
    });
    expect(cachedProvider).not.toHaveBeenCalled();

    const changedSettingsProvider = vi.fn(async () => 'fresh summary');
    const changedSettings = makeSummarizer(changedSettingsProvider, {
      contentRevision: 'rev-1',
      inputFingerprint: 'settings-b',
      priorUnits: { [persisted[0].unitId]: persisted[0] },
    });
    await changedSettings([1], { path: 'Science>AI' });
    expect(changedSettingsProvider).toHaveBeenCalledTimes(1);

    const changedRevisionProvider = vi.fn(async () => 'revised summary');
    const changedRevision = makeSummarizer(changedRevisionProvider, {
      contentRevision: 'rev-2',
      inputFingerprint: 'settings-a',
      priorUnits: { [persisted[0].unitId]: persisted[0] },
    });
    await changedRevision([1], { path: 'Science>AI' });
    expect(changedRevisionProvider).toHaveBeenCalledTimes(1);
  });

  it('uses compact deterministic unit ids that include run, path, and optional profile', () => {
    const input = {
      kind: 'chunk',
      path: 'Science>AI',
      runSentences: [1, 3, 5],
      startSentence: 3,
      endSentence: 3,
    };

    expect(sourceSummaryUnitId(input)).toBe(sourceSummaryUnitId({ ...input }));
    expect(sourceSummaryUnitId(input)).not.toBe(
      sourceSummaryUnitId({ ...input, path: 'Science>ML' }),
    );
    expect(sourceSummaryUnitId(input)).not.toBe(sourceSummaryUnitId({ ...input, profile: 'leaf' }));
  });
});
