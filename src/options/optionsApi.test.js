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
    });

    sendRuntimeMessage.mockResolvedValueOnce({ ok: true, items: [{ key: 'r1' }] });
    await expect(listRecords()).resolves.toEqual([{ key: 'r1' }]);

    sendRuntimeMessage.mockResolvedValueOnce({ ok: false });
    await expect(listRecords()).resolves.toEqual([]);
  });
});
