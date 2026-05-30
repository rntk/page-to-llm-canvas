import { describe, it, expect } from 'vitest';
import { LLM_REQUEST_TIMEOUT_MS } from './config.js';

describe('config exports', () => {
  it('exports a positive LLM_REQUEST_TIMEOUT_MS number', () => {
    expect(typeof LLM_REQUEST_TIMEOUT_MS).toBe('number');
    expect(LLM_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
