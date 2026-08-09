import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from './log.js';

describe('createLogger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges the message into an unscoped brand prefix', () => {
    const log = createLogger();
    const err = new Error('boom');
    log.warn('storage failed:', err);
    expect(console.warn).toHaveBeenCalledWith('PageToLLM Canvas: storage failed:', err);
  });

  it('places a scope between the brand and the message, without adding punctuation', () => {
    const log = createLogger('keepalive');
    const err = new Error('boom');
    log.error('listRecords failed:', err);
    expect(console.error).toHaveBeenCalledWith(
      'PageToLLM Canvas keepalive listRecords failed:',
      err,
    );
    expect(log.prefix).toBe('PageToLLM Canvas keepalive');
  });

  it('passes every remaining argument through untouched', () => {
    const details = { key: 'record-1' };
    createLogger('LLM').info('request:', details, 7);
    expect(console.info).toHaveBeenCalledWith('PageToLLM Canvas LLM request:', details, 7);
  });

  it('writes the bare prefix when no message is given', () => {
    createLogger().warn();
    expect(console.warn).toHaveBeenCalledWith('PageToLLM Canvas:');
  });

  it('ignores a non-string or blank scope', () => {
    expect(createLogger('   ').prefix).toBe('PageToLLM Canvas:');
    expect(createLogger(42).prefix).toBe('PageToLLM Canvas:');
  });

  it('keeps the prefix as its own argument for structured events', () => {
    createLogger('pipeline').event('cleaned', { chars: 12 });
    expect(console.info).toHaveBeenCalledWith('PageToLLM Canvas pipeline:', 'cleaned', {
      chars: 12,
    });
  });

  it('does not double the colon of a scope that already ends in one', () => {
    createLogger('chat:').event('request', { id: 1 });
    expect(console.info).toHaveBeenCalledWith('PageToLLM Canvas chat:', 'request', { id: 1 });
  });

  it('defaults event details and routes error events to console.error', () => {
    createLogger('chat:').event('failed', undefined, { error: true });
    expect(console.error).toHaveBeenCalledWith('PageToLLM Canvas chat:', 'failed', {});
    expect(console.info).not.toHaveBeenCalled();
  });

  it('appends child scope words to the parent scope', () => {
    expect(createLogger().child('retryRecord').prefix).toBe('PageToLLM Canvas retryRecord');
    expect(createLogger('keepalive').child('resume').prefix).toBe(
      'PageToLLM Canvas keepalive resume',
    );
    expect(createLogger('keepalive').child('').prefix).toBe('PageToLLM Canvas keepalive');
  });
});
