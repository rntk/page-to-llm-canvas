import { describe, it, expect, vi, beforeEach } from 'vitest';
import { recordMetaStorageKey, recordDiagnosticsStorageKey } from '../../worker/storage/keys.js';

const send = vi.fn();
const subscribeLocalChanges = vi.fn(() => () => {});

vi.mock('../utils/runtimeMessages.js', () => ({
  browserRuntimeMessenger: { send: (...args) => send(...args) },
}));
vi.mock('../shared/runtime/localStore.js', () => ({
  subscribeLocalChanges: (...args) => subscribeLocalChanges(...args),
}));

const { browserRecordSource } = await import('./recordSource.js');

describe('browserRecordSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sends the view-record message for the logical key', () => {
    browserRecordSource.fetch('test');
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ key: 'test' }));
  });

  // Regression: the watched keys must be the same physical keys the storage
  // layer writes. A hand-built `pagetollm:rec:${key}:` prefix silently stopped
  // matching once the writer began percent-encoding the record segment, which
  // dropped every live update for keys containing `:`.
  it('watches the physical doc keys the storage layer actually writes', () => {
    const key = 'article:123';
    browserRecordSource.subscribe(key, () => {});

    const [watchedKeys] = subscribeLocalChanges.mock.calls[0];
    expect(watchedKeys).toContain(recordMetaStorageKey(key));
    expect(watchedKeys).toContain(recordDiagnosticsStorageKey(key));
    expect(watchedKeys.every((k) => !k.includes(':123:'))).toBe(true);
  });

  it('returns the unsubscribe handle from the store', () => {
    const unsubscribe = () => {};
    subscribeLocalChanges.mockReturnValueOnce(unsubscribe);
    expect(browserRecordSource.subscribe('test', () => {})).toBe(unsubscribe);
  });
});
