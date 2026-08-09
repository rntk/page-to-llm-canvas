import { describe, expect, it } from 'vitest';

import {
  isCancellationError,
  markCancellation,
  rethrowIfCancelled,
  throwIfCancelled,
} from './cancellation.js';
import { markProviderFailure } from './providerFailure.js';

function abortedRuntime(reason) {
  const controller = new AbortController();
  if (reason === undefined) controller.abort();
  else controller.abort(reason);
  return { signal: controller.signal };
}

function activeRuntime() {
  return { signal: new AbortController().signal };
}

function abortError(message = 'The user aborted a request.') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

describe('isCancellationError', () => {
  it('recognizes an AbortError raised while this run is aborted', () => {
    expect(isCancellationError(abortError(), abortedRuntime())).toBe(true);
  });

  it('recognizes the signal exact abort reason without an AbortError name', () => {
    const reason = new Error('cancelled by user');
    expect(isCancellationError(reason, abortedRuntime(reason))).toBe(true);
  });

  it('follows the cause chain of a wrapped cancellation', () => {
    const wrapped = new Error('summarize failed', { cause: abortError() });
    expect(isCancellationError(wrapped, abortedRuntime())).toBe(true);
  });

  it('ignores an abort-shaped error while this run is still active', () => {
    // The nit this guards: a transport timeout surfaced as AbortError used to be
    // swallowed as cancellation, leaving the record stuck in SUMMARIZING.
    const runtime = activeRuntime();
    expect(isCancellationError(abortError('The operation timed out.'), runtime)).toBe(false);
    const codeOnly = new Error('aborted');
    codeOnly.code = 'ABORT_ERR';
    expect(isCancellationError(codeOnly, runtime)).toBe(false);
  });

  it('accepts a marked cancellation even though the signal never aborted', () => {
    // Ownership loss (the run-id CAS in pipelineRuntime) cancels this run
    // without aborting its signal.
    const superseded = markCancellation(abortError('Pipeline run is no longer current'));
    expect(isCancellationError(superseded, activeRuntime())).toBe(true);
    expect(isCancellationError(new Error('wrapped', { cause: superseded }), activeRuntime())).toBe(
      true,
    );
  });

  it('does not flag a provider failure that settles after the abort wins', () => {
    const runtime = abortedRuntime();
    expect(isCancellationError(markProviderFailure(new Error('429 rate limited')), runtime)).toBe(
      false,
    );
    expect(isCancellationError(new TypeError('Cannot read properties of undefined'), runtime)).toBe(
      false,
    );
  });

  it('trusts abort shape when no runtime is available', () => {
    expect(isCancellationError(abortError())).toBe(true);
    expect(isCancellationError(new Error('401 invalid api key'))).toBe(false);
  });

  it('tolerates cyclic causes and non-object rejections', () => {
    const error = new Error('outer');
    error.cause = error;
    expect(isCancellationError(error, abortedRuntime())).toBe(false);
    expect(isCancellationError('prompt template missing', abortedRuntime())).toBe(false);
    expect(isCancellationError(undefined, abortedRuntime())).toBe(false);
  });
});

describe('throwIfCancelled', () => {
  it('does nothing while the run is active', () => {
    expect(() => throwIfCancelled(activeRuntime())).not.toThrow();
    expect(() => throwIfCancelled(undefined)).not.toThrow();
  });

  it('rethrows the signal own abort reason unchanged', () => {
    const reason = abortError('cancelled by user');
    expect(() => throwIfCancelled(abortedRuntime(reason))).toThrow(reason);
  });

  it('normalizes a non-abort reason into a recognizable cancellation', () => {
    const reason = new Error('superseded by run-8');
    let thrown;
    try {
      throwIfCancelled(abortedRuntime(reason), 'pipeline aborted during summarization');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'AbortError',
      message: 'pipeline aborted during summarization',
      cause: reason,
    });
    // The marker keeps it cancellation even for a catch that no longer sees an
    // aborted signal.
    expect(isCancellationError(thrown, activeRuntime())).toBe(true);
  });
});

describe('rethrowIfCancelled', () => {
  it('returns silently for a provider failure on an active run', () => {
    expect(() =>
      rethrowIfCancelled(markProviderFailure(new Error('timed out')), activeRuntime()),
    ).not.toThrow();
  });

  it('returns silently for an abort-shaped failure on an active run', () => {
    // The stage must be free to park this as a retryable provider failure.
    expect(() =>
      rethrowIfCancelled(abortError('The operation timed out.'), activeRuntime()),
    ).not.toThrow();
  });

  it('preserves the identity of a genuine AbortError', () => {
    const error = abortError();
    expect(() => rethrowIfCancelled(error, abortedRuntime())).toThrow(error);
  });

  it('normalizes a cancellation that is not abort-shaped', () => {
    const reason = new Error('cancelled by user');
    let thrown;
    try {
      rethrowIfCancelled(reason, abortedRuntime(reason), 'pipeline aborted during topic ranging');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      name: 'AbortError',
      message: 'pipeline aborted during topic ranging',
      cause: reason,
    });
    expect(isCancellationError(thrown, activeRuntime())).toBe(true);
  });

  it('rethrows an unrelated error that settles after the abort', () => {
    // Rethrown as-is so the stage does not replace it with an AbortError at its
    // next log/update boundary.
    const raceError = new TypeError('Cannot read properties of undefined');
    expect(() => rethrowIfCancelled(raceError, abortedRuntime())).toThrow(raceError);
  });
});

describe('markCancellation', () => {
  it('returns the same error and survives an unwritable value', () => {
    const error = new Error('cancelled');
    expect(markCancellation(error)).toBe(error);
    const frozen = Object.freeze(new Error('frozen'));
    expect(markCancellation(frozen)).toBe(frozen);
    expect(markCancellation('cancelled')).toBe('cancelled');
  });
});
