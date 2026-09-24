import { describe, expect, it } from 'vitest';
import { isPermanentProviderError } from './providerFailure.js';

describe('isPermanentProviderError', () => {
  it.each([
    [400, true],
    [401, true],
    [403, true],
    [404, true],
    [408, false],
    [409, true],
    [422, true],
    [429, false],
    [500, false],
  ])('classifies HTTP %i as permanent=%s', (status, permanent) => {
    expect(isPermanentProviderError({ status })).toBe(permanent);
  });
});
