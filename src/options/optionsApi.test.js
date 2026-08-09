import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendRuntimeMessage = vi.hoisted(() => vi.fn());
vi.mock('../utils/runtimeMessages.js', () => ({ sendRuntimeMessage }));

import { listProviders, listRecords, sendMessage } from './optionsApi.js';

describe('options API', () => {
  beforeEach(() => {
    sendRuntimeMessage.mockReset();
  });

  it('passes messages through and converts transport failures to undefined', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({ ok: true });
    await expect(sendMessage({ type: 'listRecords' })).resolves.toEqual({ ok: true });

    sendRuntimeMessage.mockRejectedValueOnce(new Error('disconnected'));
    await expect(sendMessage({ type: 'listRecords' })).resolves.toBeUndefined();
  });

  it('normalizes provider responses and records lists', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({
      ok: true,
      providers: [{ id: 'p1' }],
      activeId: 'p1',
    });
    await expect(listProviders()).resolves.toEqual({
      providers: [{ id: 'p1' }],
      activeId: 'p1',
      error: null,
      transportError: false,
    });

    sendRuntimeMessage.mockResolvedValueOnce({ ok: true, items: [{ key: 'r1' }] });
    await expect(listRecords()).resolves.toEqual({
      items: [{ key: 'r1' }],
      error: null,
      transportError: false,
    });
  });

  // Was: an `{ok:false}` response silently resolved to an empty list,
  // indistinguishable from "there really are no records". Now the caller gets
  // an explicit error so it can render a retry affordance instead of "No
  // records yet".
  it('surfaces an explicit {ok:false} response as a load error instead of an empty list', async () => {
    sendRuntimeMessage.mockResolvedValueOnce({ ok: false, error: 'storage read failed' });
    await expect(listRecords()).resolves.toEqual({
      items: null,
      error: 'storage read failed',
      transportError: false,
    });

    sendRuntimeMessage.mockResolvedValueOnce({ ok: false });
    await expect(listProviders()).resolves.toEqual({
      providers: null,
      activeId: null,
      error: null,
      transportError: false,
    });
  });

  // Was: a rejected sendRuntimeMessage (chrome.runtime.lastError) silently
  // mapped to `undefined` and then to an empty list/providers object - the
  // exact U1 bug. Now it is flagged distinctly (`transportError: true`) so
  // the UI can tell "couldn't reach the worker" apart from "worker said no".
  it('surfaces a transport failure distinctly from an {ok:false} response', async () => {
    sendRuntimeMessage.mockRejectedValueOnce(new Error('Extension context invalidated.'));
    await expect(listRecords()).resolves.toEqual({
      items: null,
      error: 'Extension context invalidated.',
      transportError: true,
    });

    sendRuntimeMessage.mockRejectedValueOnce(new Error('disconnected'));
    await expect(listProviders()).resolves.toEqual({
      providers: null,
      activeId: null,
      error: 'disconnected',
      transportError: true,
    });
  });
});
