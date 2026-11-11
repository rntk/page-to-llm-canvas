import { describe, it, expect, vi } from 'vitest';
import { createRecordLoader } from './recordLoader.js';
import { assessRecordForRail } from './recordFetch.js';

function build({ response, stale = false } = {}) {
  const beginLoad = vi.fn(() => ({ isStale: () => stale }));
  const send = vi.fn(async ({ type }) => {
    if (type === 'openOptionsPage') return { ok: true };
    return response;
  });
  const alert = vi.fn();
  const logger = { warn: vi.fn() };
  const loader = createRecordLoader({
    surfaceManager: { beginLoad },
    runtimeMessenger: { send },
    alert,
    logger,
  });
  return { loader, beginLoad, send, alert, logger };
}

const found = (record) => ({ ok: true, record });

describe('createRecordLoader', () => {
  it('returns the guard and a ready assessment for a done record', async () => {
    const record = { key: 'k', status: 'done' };
    const { loader, beginLoad } = build({ response: found(record) });
    const { guard, assessment } = await loader.load('k');
    expect(beginLoad).toHaveBeenCalledOnce();
    expect(guard.isStale()).toBe(false);
    expect(assessment).toEqual({ kind: 'ready', record });
  });

  it('drops superseded requests silently', async () => {
    const { loader, alert, send } = build({ response: { ok: false }, stale: true });
    const { assessment } = await loader.load('k');
    expect(assessment).toBeNull();
    expect(alert).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('reports fetch failures and logs the underlying error', async () => {
    const { loader, alert, logger } = build({ response: { ok: false, error: 'boom' } });
    const { assessment } = await loader.load('k');
    expect(assessment).toBeNull();
    expect(alert).toHaveBeenCalledWith(
      'PageToLLM: The analysis service could not load this record.',
    );
    expect(logger.warn).toHaveBeenCalledWith('record fetch failed:', expect.any(Error));
  });

  it('does not log an ordinary repository miss', async () => {
    const { loader, alert, logger } = build({ response: { ok: false } });
    await loader.load('k');
    expect(alert).toHaveBeenCalledWith('PageToLLM: Analysis record not found.');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each(['error', 'cancelled', 'needs_attention'])(
    'routes %s records to Options recovery',
    async (status) => {
      const { loader, send, alert } = build({ response: found({ key: 'k', status }) });
      const { assessment } = await loader.load('k');
      expect(assessment).toBeNull();
      expect(send).toHaveBeenCalledWith({ type: 'openOptionsPage' });
      expect(alert).not.toHaveBeenCalled();
    },
  );

  it('tells the user to wait while analysis is in progress', async () => {
    const { loader, alert } = build({
      response: found({ key: 'k', status: 'running', progress: { stage: 'summarizing' } }),
    });
    const { assessment } = await loader.load('k');
    expect(assessment).toBeNull();
    expect(alert).toHaveBeenCalledWith(
      'PageToLLM: Analysis is currently in progress (status: summarizing). Please wait a moment and try again.',
    );
  });

  it('passes surface-specific assessments through to the caller', async () => {
    const record = { key: 'k', status: 'done', selectors: [] };
    const { loader, alert } = build({ response: found(record) });
    const { assessment } = await loader.load('k', { assess: assessRecordForRail });
    expect(assessment).toEqual({ kind: 'no_selectors', record });
    expect(alert).not.toHaveBeenCalled();
  });
});
