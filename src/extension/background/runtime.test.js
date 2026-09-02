// Covers the listener wiring itself, which is otherwise asserted nowhere: the
// existing background suite only ever pulls the `onMessage` listener back out
// of its chrome mock. A mistake here (a listener attached to the wrong event, a
// dropped storage-prefix filter, a lost synchronous `return false`) is silent
// in production, because MV3 just stops delivering the event.
//
// No `chrome` global: the namespaces are plain fakes passed in.
import { describe, it, expect, vi } from 'vitest';
import { installBackgroundRuntime, RECORD_STORAGE_PREFIX } from './runtime.js';

function setup(overrides = {}) {
  const chromeRuntime = {
    onMessage: { addListener: vi.fn() },
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
  };
  const chromeAlarms = { onAlarm: { addListener: vi.fn() } };
  const chromeStorage = { onChanged: { addListener: vi.fn() } };
  const pipelineSupervisor = {
    handleKeepAliveAlarm: vi.fn(),
    resumeInFlightRecords: vi.fn(async () => {}),
  };
  const dispatchMessage = vi.fn(async () => ({ ok: true }));
  const scheduleActionProgressIconRefresh = vi.fn();

  const deps = {
    chromeRuntime,
    chromeAlarms,
    chromeStorage,
    dispatchMessage,
    pipelineSupervisor,
    scheduleActionProgressIconRefresh,
    ...overrides,
  };
  installBackgroundRuntime(deps);

  return {
    ...deps,
    alarmListener: chromeAlarms.onAlarm.addListener.mock.calls[0]?.[0],
    storageListener: chromeStorage.onChanged.addListener.mock.calls[0]?.[0],
    messageListener: chromeRuntime.onMessage.addListener.mock.calls[0]?.[0],
    startupListener: chromeRuntime.onStartup.addListener.mock.calls[0]?.[0],
    installedListener: chromeRuntime.onInstalled.addListener.mock.calls[0]?.[0],
  };
}

describe('installBackgroundRuntime (no chrome global)', () => {
  it('registers exactly one listener on each event', () => {
    expect(globalThis.chrome).toBeUndefined();
    const ctx = setup();
    expect(ctx.chromeAlarms.onAlarm.addListener).toHaveBeenCalledTimes(1);
    expect(ctx.chromeStorage.onChanged.addListener).toHaveBeenCalledTimes(1);
    expect(ctx.chromeRuntime.onMessage.addListener).toHaveBeenCalledTimes(1);
    expect(ctx.chromeRuntime.onStartup.addListener).toHaveBeenCalledTimes(1);
    expect(ctx.chromeRuntime.onInstalled.addListener).toHaveBeenCalledTimes(1);
  });

  it('routes alarms to the supervisor, which owns the keepalive rules', () => {
    const ctx = setup();
    const alarm = { name: 'pipeline-keepalive' };
    ctx.alarmListener(alarm);
    expect(ctx.pipelineSupervisor.handleKeepAliveAlarm).toHaveBeenCalledWith(alarm);
  });

  it('refreshes the action icon only for local record-storage changes', () => {
    const ctx = setup();
    const { storageListener, scheduleActionProgressIconRefresh: refresh } = ctx;

    storageListener({ [`${RECORD_STORAGE_PREFIX}abc`]: {} }, 'local');
    expect(refresh).toHaveBeenCalledTimes(1);

    // Wrong area: sync writes never affect the local record set.
    storageListener({ [`${RECORD_STORAGE_PREFIX}abc`]: {} }, 'sync');
    // Right area, unrelated key: settings and metrics must not repaint the icon.
    storageListener({ 'pagetollm:settings': {} }, 'local');
    storageListener({}, 'local');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('survives a runtime without chrome.storage', () => {
    expect(() => setup({ chromeStorage: undefined })).not.toThrow();
  });

  it('answers a typeless message synchronously and keeps the channel closed', () => {
    const ctx = setup();
    const sendResponse = vi.fn();

    const kept = ctx.messageListener({}, {}, sendResponse);

    // `false` must be returned synchronously, or Chrome holds the port open.
    expect(kept).toBe(false);
    expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'no type' });
    expect(ctx.dispatchMessage).not.toHaveBeenCalled();
  });

  it('keeps the channel open and answers with the dispatch result', async () => {
    const ctx = setup();
    ctx.dispatchMessage.mockResolvedValue({ ok: true, items: [] });
    const sendResponse = vi.fn();
    const msg = { type: 'listRecords' };
    const sender = { url: 'chrome-extension://test-id/options.html' };

    expect(ctx.messageListener(msg, sender, sendResponse)).toBe(true);

    expect(ctx.dispatchMessage).toHaveBeenCalledWith(msg, sender);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalledWith({ ok: true, items: [] }));
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  it('answers exactly once when dispatch rejects', async () => {
    const ctx = setup();
    ctx.dispatchMessage.mockRejectedValue(new Error('dispatch exploded'));
    const sendResponse = vi.fn();

    ctx.messageListener({ type: 'listRecords' }, {}, sendResponse);

    await vi.waitFor(() =>
      expect(sendResponse).toHaveBeenCalledWith({ ok: false, error: 'dispatch exploded' }),
    );
    expect(sendResponse).toHaveBeenCalledTimes(1);
  });

  // Not covered here: a `sendResponse` that itself throws. The listener uses
  // the two-argument `.then(onFulfilled, onRejected)` form precisely so that
  // throw is *not* routed into the rejection handler and answered twice — it
  // surfaces as an unhandled rejection instead, which a test cannot observe
  // without failing the run on the very error it is asserting.

  it('resumes orphaned records on browser start and on install/update', async () => {
    const ctx = setup();

    ctx.startupListener();
    ctx.installedListener();

    // Both resumes are deferred behind the bootstrap, so they land a microtask
    // after the synchronous listener call.
    await vi.waitFor(() =>
      expect(ctx.pipelineSupervisor.resumeInFlightRecords).toHaveBeenCalledTimes(2),
    );
  });

  it('waits for the cold-start bootstrap before resuming', async () => {
    let releaseBootstrap;
    const bootstrapReady = () => new Promise((resolve) => (releaseBootstrap = resolve));
    const ctx = setup({ bootstrapReady });

    ctx.startupListener();
    await Promise.resolve();
    // Reconciliation is still in flight: resuming now could read records it has
    // not repaired yet.
    expect(ctx.pipelineSupervisor.resumeInFlightRecords).not.toHaveBeenCalled();

    releaseBootstrap();
    await vi.waitFor(() =>
      expect(ctx.pipelineSupervisor.resumeInFlightRecords).toHaveBeenCalledTimes(1),
    );
  });

  it('still resumes when the bootstrap rejects', async () => {
    const ctx = setup({ bootstrapReady: () => Promise.reject(new Error('reconcile boom')) });

    ctx.startupListener();
    // A failed bootstrap must not strand in-flight records forever: the
    // reconcile-first ordering is a preference, resuming at all is the
    // requirement.
    await vi.waitFor(() =>
      expect(ctx.pipelineSupervisor.resumeInFlightRecords).toHaveBeenCalledTimes(1),
    );
  });

  it('skips the startup hooks on a runtime that does not expose them', () => {
    const chromeRuntime = { onMessage: { addListener: vi.fn() } };
    expect(() => setup({ chromeRuntime })).not.toThrow();
    expect(chromeRuntime.onMessage.addListener).toHaveBeenCalledTimes(1);
  });
});
