import { describe, expect, it } from 'vitest';
import { PIPELINE_STATUS } from './contracts.js';
import { applyPipelineFailures } from './pipelineFailures.js';

describe('applyPipelineFailures', () => {
  it('creates UI projections without mutating persisted records', () => {
    const record = { key: 'a', status: PIPELINE_STATUS.SUMMARIZING, error: null };
    const failure = {
      kind: 'storage_unavailable',
      message: 'Storage unavailable',
      retryable: true,
    };

    const [visible] = applyPipelineFailures([record], { a: failure });

    expect(visible).toEqual({
      ...record,
      status: PIPELINE_STATUS.ERROR,
      error: failure.message,
      pipelineFailure: failure,
    });
    expect(record).toEqual({ key: 'a', status: PIPELINE_STATUS.SUMMARIZING, error: null });
  });
});
