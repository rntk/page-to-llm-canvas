import { describe, it, expect } from 'vitest';
import {
  hasSummaryRunMarker,
  isFailedSummaryRun,
  acceptFailedSummaryRun,
  publicSummaryRun,
  reacceptForcedEmptySummaries,
} from './summaryRunMarkers.js';

describe('hasSummaryRunMarker', () => {
  it('is true for error, forcedEmpty, or acceptedFailure runs', () => {
    expect(hasSummaryRunMarker({ error: true })).toBe(true);
    expect(hasSummaryRunMarker({ forcedEmpty: true })).toBe(true);
    expect(hasSummaryRunMarker({ acceptedFailure: true })).toBe(true);
  });

  it('is false for a plain successful run or a missing run', () => {
    expect(hasSummaryRunMarker({ sentences: [1], text: 'ok' })).toBe(false);
    expect(hasSummaryRunMarker(undefined)).toBe(false);
  });
});

describe('isFailedSummaryRun', () => {
  it('is true for error or forcedEmpty runs', () => {
    expect(isFailedSummaryRun({ error: true })).toBe(true);
    expect(isFailedSummaryRun({ forcedEmpty: true })).toBe(true);
  });

  it('excludes acceptedFailure so Skip is not retried on an ordinary resume', () => {
    expect(isFailedSummaryRun({ acceptedFailure: true })).toBe(false);
  });

  it('is false for a missing run instead of throwing', () => {
    expect(isFailedSummaryRun(undefined)).toBe(false);
    expect(isFailedSummaryRun(null)).toBe(false);
  });
});

describe('acceptFailedSummaryRun', () => {
  it('strips failure fields and marks the run accepted', () => {
    const run = {
      sentences: [1, 2],
      text: '',
      error: true,
      error_kind: 'timeout',
      error_message: 'old failure',
      error_detail: 'detail',
      forcedEmpty: true,
    };
    expect(acceptFailedSummaryRun(run)).toEqual({
      sentences: [1, 2],
      text: '',
      acceptedFailure: true,
    });
  });

  it('passes a non-failed run through unchanged', () => {
    const run = { sentences: [1], text: 'Good.' };
    expect(acceptFailedSummaryRun(run)).toBe(run);
  });
});

describe('publicSummaryRun', () => {
  it('projects sentences, text, and only the error/forcedEmpty markers', () => {
    expect(publicSummaryRun({ sentences: [1], text: 'x', error: true })).toEqual({
      sentences: [1],
      text: 'x',
      error: true,
    });
    expect(publicSummaryRun({ sentences: [1], text: 'x', forcedEmpty: true })).toEqual({
      sentences: [1],
      text: 'x',
      forcedEmpty: true,
    });
    expect(publicSummaryRun({ sentences: [1], text: 'x', acceptedFailure: true })).toEqual({
      sentences: [1],
      text: 'x',
    });
  });

  it('defaults a non-string text to an empty string', () => {
    expect(publicSummaryRun({ sentences: [1], text: undefined })).toEqual({
      sentences: [1],
      text: '',
    });
  });

  it('projects a missing run without throwing', () => {
    expect(publicSummaryRun(undefined)).toEqual({ text: '' });
    expect(publicSummaryRun(null)).toEqual({ text: '' });
  });
});

describe('reacceptForcedEmptySummaries', () => {
  it('converts a forcedEmpty run into acceptedFailure and drops the topic-level marker', () => {
    const summaries = {
      History: {
        source_sentences: [3],
        runs: [{ sentences: [3], text: '', forcedEmpty: true }],
        forcedEmpty: true,
      },
    };

    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(hasAcceptedFailure).toBe(true);
    expect(result.History).toEqual({
      source_sentences: [3],
      runs: [{ sentences: [3], text: '', acceptedFailure: true }],
      acceptedFailure: true,
    });
    expect(result.History.forcedEmpty).toBeUndefined();
  });

  it('converts only the forcedEmpty runs within an entry, leaving other runs untouched', () => {
    const summaries = {
      Science: {
        source_sentences: [1, 2],
        runs: [
          { sentences: [1], text: 'Kept summary.' },
          { sentences: [2], text: '', forcedEmpty: true },
        ],
        forcedEmpty: true,
      },
    };

    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(hasAcceptedFailure).toBe(true);
    expect(result.Science.runs).toEqual([
      { sentences: [1], text: 'Kept summary.' },
      { sentences: [2], text: '', acceptedFailure: true },
    ]);
    expect(result.Science.acceptedFailure).toBe(true);
    expect(result.Science.forcedEmpty).toBeUndefined();
  });

  it('passes entries without any forcedEmpty run through unchanged, by reference', () => {
    const untouched = {
      runs: [{ sentences: [1], text: 'Good.' }],
      source_sentences: [1],
    };
    const withError = {
      runs: [{ sentences: [2], text: '', error: true }],
      source_sentences: [2],
      error: true,
    };
    const summaries = { A: untouched, B: withError };

    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(result.A).toBe(untouched);
    expect(result.B).toBe(withError);
    expect(hasAcceptedFailure).toBe(false);
  });

  it('reports hasAcceptedFailure only when at least one entry had a forcedEmpty run', () => {
    const summaries = {
      A: { runs: [{ sentences: [1], text: 'Good.' }], source_sentences: [1] },
      B: {
        runs: [{ sentences: [2], text: '', forcedEmpty: true }],
        source_sentences: [2],
        forcedEmpty: true,
      },
    };

    const { hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(hasAcceptedFailure).toBe(true);
  });

  it('handles an empty or missing summaries map', () => {
    expect(reacceptForcedEmptySummaries({})).toEqual({ summaries: {}, hasAcceptedFailure: false });
    expect(reacceptForcedEmptySummaries(undefined)).toEqual({
      summaries: {},
      hasAcceptedFailure: false,
    });
  });

  it('treats a summary with a non-array runs field as having no forcedEmpty runs', () => {
    const malformed = { runs: null, forcedEmpty: true };
    const summaries = { A: malformed };

    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(result.A).toBe(malformed);
    expect(hasAcceptedFailure).toBe(false);
  });

  it('treats a missing summary entry as having no forcedEmpty runs', () => {
    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries({
      A: undefined,
    });

    expect(result.A).toBeUndefined();
    expect(hasAcceptedFailure).toBe(false);
  });

  it('passes null runs through without throwing', () => {
    const withNull = { runs: [null], source_sentences: [] };
    const summaries = { A: withNull };

    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(result.A).toBe(withNull);
    expect(hasAcceptedFailure).toBe(false);
  });

  it('leaves an error-only run alone when a sibling run is forcedEmpty', () => {
    const errorRun = { sentences: [1], text: '', error: true };
    const summaries = {
      Science: {
        source_sentences: [1, 2],
        runs: [{ sentences: [2], text: '', forcedEmpty: true }, errorRun],
        forcedEmpty: true,
      },
    };

    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(hasAcceptedFailure).toBe(true);
    expect(result.Science.runs[1]).toBe(errorRun);
    expect(result.Science.runs[1]).toEqual({ sentences: [1], text: '', error: true });
  });

  it('passes a null run through when a sibling run is forcedEmpty', () => {
    const summaries = {
      Science: {
        source_sentences: [2],
        runs: [{ sentences: [2], text: '', forcedEmpty: true }, null],
        forcedEmpty: true,
      },
    };

    const { summaries: result, hasAcceptedFailure } = reacceptForcedEmptySummaries(summaries);

    expect(hasAcceptedFailure).toBe(true);
    expect(result.Science.runs[1]).toBeNull();
  });
});
