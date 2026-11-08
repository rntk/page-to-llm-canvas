import { describe, expect, it } from 'vitest';
import { errorMessage } from './errorMessage.js';

describe('errorMessage', () => {
  it('uses an Error message and stringifies other thrown values', () => {
    expect(errorMessage(new Error('broken'))).toBe('broken');
    expect(errorMessage(null)).toBe('null');
    expect(errorMessage(undefined)).toBe('undefined');
    expect(errorMessage(false)).toBe('false');
    expect(errorMessage(0)).toBe('0');
    expect(errorMessage('failure')).toBe('failure');
    expect(errorMessage({ message: 'detail' })).toBe('detail');
  });
});
