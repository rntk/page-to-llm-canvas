import { describe, it, expect, vi } from 'vitest';
import { createOptionsRecoveryOpener } from './optionsRecovery.js';

const MANUAL_HINT = 'PageToLLM: Open the extension Options page to review this analysis.';

function build(sendImpl) {
  const send = vi.fn(sendImpl);
  const alert = vi.fn();
  const logger = { warn: vi.fn() };
  const open = createOptionsRecoveryOpener({ runtimeMessenger: { send }, alert, logger });
  return { open, send, alert, logger };
}

describe('createOptionsRecoveryOpener', () => {
  it('asks the worker to open Options and stays quiet on success', async () => {
    const { open, send, alert } = build(async () => ({ ok: true }));
    await open();
    expect(send).toHaveBeenCalledWith({ type: 'openOptionsPage' });
    expect(alert).not.toHaveBeenCalled();
  });

  it('falls back to a manual hint when the worker reports failure', async () => {
    const { open, alert, logger } = build(async () => ({ ok: false, error: 'nope' }));
    await open();
    expect(alert).toHaveBeenCalledWith(MANUAL_HINT);
    expect(logger.warn).toHaveBeenCalledWith('open options failed:', 'nope');
  });

  it('falls back to a manual hint when the worker is unreachable', async () => {
    const error = new Error('disconnected');
    const { open, alert, logger } = build(async () => {
      throw error;
    });
    await open();
    expect(alert).toHaveBeenCalledWith(MANUAL_HINT);
    expect(logger.warn).toHaveBeenCalledWith('open options failed:', error);
  });

  it('treats a missing or malformed response as failure', async () => {
    const { open, alert } = build(async () => undefined);
    await open();
    expect(alert).toHaveBeenCalledWith(MANUAL_HINT);
  });
});
