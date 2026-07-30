import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getStoredVerboseLogs = vi.hoisted(() => vi.fn());
vi.mock('../shared/runtime/verboseLogSettings.js', () => ({ getStoredVerboseLogs }));

import { createChatLogger } from './chatLogger.js';

describe('chat logger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getStoredVerboseLogs.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('buffers early verbose events and replays them when verbose logging is enabled', async () => {
    let resolveSetting;
    getStoredVerboseLogs.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSetting = resolve;
      }),
    );
    const log = createChatLogger();

    log('request', { id: 1 }, { verbose: true });
    expect(console.info).not.toHaveBeenCalled();
    resolveSetting(true);
    await Promise.resolve();

    expect(console.info).toHaveBeenCalledWith('PageToLLM Canvas chat:', 'request', { id: 1 });
  });

  it('suppresses verbose events when disabled but always logs errors', async () => {
    getStoredVerboseLogs.mockResolvedValueOnce(false);
    const log = createChatLogger();
    await Promise.resolve();

    log('details', {}, { verbose: true });
    expect(console.info).not.toHaveBeenCalled();
    log('failed', { reason: 'network' }, { error: true });
    expect(console.error).toHaveBeenCalledWith('PageToLLM Canvas chat:', 'failed', {
      reason: 'network',
    });
  });
});
