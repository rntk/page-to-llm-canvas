import { describe, expect, it, vi } from 'vitest';
import { createContentSurfaceCoordinator } from './surfaceCoordinator.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function createHarness(overrides = {}) {
  const railSurface = { open: vi.fn(async () => true), close: vi.fn(), destroy: vi.fn() };
  const frameManager = {
    open: vi.fn(() => ({ contentWindow: {} })),
    close: vi.fn(),
    getActiveFrame: vi.fn(() => null),
  };
  const loaders = {
    selection: vi.fn(async () => ({
      createSelectionSurface: vi.fn(() => ({ destroy: vi.fn() })),
    })),
    inPageRail: vi.fn(async () => ({
      createInPageRailSurface: vi.fn(() => railSurface),
    })),
    youTubeRail: vi.fn(async () => ({
      createYouTubeRailSurface: vi.fn(() => railSurface),
    })),
    recordFrame: vi.fn(async () => ({
      createRecordFrameSurface: vi.fn(() => frameManager),
    })),
    ...overrides,
  };
  const dialogs = { alert: vi.fn(), confirm: vi.fn() };
  const coordinator = createContentSurfaceCoordinator({
    document: {},
    runtimeMessenger: {},
    dialogs,
    loaders,
  });
  return { coordinator, dialogs, frameManager, loaders };
}

describe('content surface coordinator lazy loading', () => {
  it('does not load any surface implementation during bootstrap', () => {
    const { loaders } = createHarness();
    expect(loaders.selection).not.toHaveBeenCalled();
    expect(loaders.inPageRail).not.toHaveBeenCalled();
    expect(loaders.youTubeRail).not.toHaveBeenCalled();
    expect(loaders.recordFrame).not.toHaveBeenCalled();
  });

  it.each([
    ['in-page', undefined, 'inPageRail', 'createInPageRailSurface'],
    ['YouTube', 'youtube', 'youTubeRail', 'createYouTubeRailSurface'],
  ])('retries a failed %s rail module load', async (_label, kind, loaderName, exportName) => {
    const surface = { open: vi.fn(async () => true), close: vi.fn(), destroy: vi.fn() };
    const loader = vi
      .fn()
      .mockRejectedValueOnce(new Error('transient import failure'))
      .mockResolvedValueOnce({ [exportName]: () => surface });
    const { coordinator } = createHarness({ [loaderName]: loader });

    await expect(coordinator.openRail({ key: 'one' }, 'topics', kind)).rejects.toThrow(
      'transient import failure',
    );
    await expect(coordinator.openRail({ key: 'two' }, 'topics', kind)).resolves.toBe(true);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it('cancels a delayed selection import when a frame wins the race', async () => {
    const selectionModule = deferred();
    const createSelectionSurface = vi.fn(() => ({ destroy: vi.fn() }));
    const { coordinator, frameManager } = createHarness({
      selection: vi.fn(() => selectionModule.promise),
    });

    const selectionOpen = coordinator.openSelection();
    await Promise.resolve();
    const frameOpen = coordinator.openRecordFrame('newer');
    selectionModule.resolve({ createSelectionSurface });

    await expect(selectionOpen).resolves.toBe(false);
    await expect(frameOpen).resolves.toEqual({ contentWindow: {} });
    expect(createSelectionSurface).not.toHaveBeenCalled();
    expect(frameManager.open).toHaveBeenCalledWith('newer', undefined);
  });

  it.each([
    ['in-page', undefined, 'inPageRail', 'createInPageRailSurface'],
    ['YouTube', 'youtube', 'youTubeRail', 'createYouTubeRailSurface'],
  ])(
    'destroys a %s rail surface created after the coordinator was destroyed',
    async (_label, kind, loaderName, exportName) => {
      const railModule = deferred();
      const lateSurface = { open: vi.fn(async () => true), close: vi.fn(), destroy: vi.fn() };
      const freshSurface = { open: vi.fn(async () => true), close: vi.fn(), destroy: vi.fn() };
      const loader = vi
        .fn()
        .mockReturnValueOnce(railModule.promise)
        .mockResolvedValueOnce({ [exportName]: () => freshSurface });
      const { coordinator } = createHarness({ [loaderName]: loader });

      const railOpen = coordinator.openRail({ key: 'late' }, 'topics', kind);
      await Promise.resolve();
      coordinator.destroy();
      railModule.resolve({ [exportName]: () => lateSurface });

      await expect(railOpen).resolves.toBe(false);
      expect(lateSurface.open).not.toHaveBeenCalled();
      expect(lateSurface.destroy).toHaveBeenCalledTimes(1);

      // The orphaned surface must not be reused by a later request.
      await expect(coordinator.openRail({ key: 'next' }, 'topics', kind)).resolves.toBe(true);
      expect(loader).toHaveBeenCalledTimes(2);
      expect(freshSurface.open).toHaveBeenCalledWith({ key: 'next' }, 'topics', {});
    },
  );

  it('tears down a rail whose open is still pending when the coordinator is destroyed', async () => {
    const mounted = deferred();
    const surface = { open: vi.fn(() => mounted.promise), close: vi.fn(), destroy: vi.fn() };
    const { coordinator } = createHarness({
      inPageRail: vi.fn(async () => ({ createInPageRailSurface: () => surface })),
    });

    const railOpen = coordinator.openRail({ key: 'rail' }, 'topics');
    await vi.waitFor(() => expect(surface.open).toHaveBeenCalled());
    coordinator.destroy();
    mounted.resolve(true);

    await expect(railOpen).resolves.toBe(false);
    expect(surface.close).toHaveBeenCalled();
    expect(surface.destroy).toHaveBeenCalledTimes(1);
  });

  it('keeps a rail surface cached when a newer surface supersedes its creation', async () => {
    const railModule = deferred();
    const surface = { open: vi.fn(async () => true), close: vi.fn(), destroy: vi.fn() };
    const inPageRail = vi.fn(() => railModule.promise);
    const { coordinator } = createHarness({ inPageRail });

    const railOpen = coordinator.openRail({ key: 'old' }, 'topics');
    await Promise.resolve();
    const selectionOpen = coordinator.openSelection();
    railModule.resolve({ createInPageRailSurface: () => surface });

    await expect(railOpen).resolves.toBe(false);
    await expect(selectionOpen).resolves.toEqual({ destroy: expect.any(Function) });
    expect(surface.open).not.toHaveBeenCalled();
    expect(surface.destroy).not.toHaveBeenCalled();

    await expect(coordinator.openRail({ key: 'new' }, 'topics')).resolves.toBe(true);
    expect(inPageRail).toHaveBeenCalledTimes(1);
  });

  it('reports a record-frame load failure triggered from an in-page rail', async () => {
    let openRecordFrameFromRail;
    const inPageRail = vi.fn(async () => ({
      createInPageRailSurface: vi.fn((options) => {
        openRecordFrameFromRail = options.openRecordFrame;
        return { open: vi.fn(async () => true), close: vi.fn(), destroy: vi.fn() };
      }),
    }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { coordinator, dialogs } = createHarness({
      inPageRail,
      recordFrame: vi.fn(async () => {
        throw new Error('frame import failed');
      }),
    });

    await coordinator.openRail({ key: 'rail' }, 'topics');
    openRecordFrameFromRail('frame');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(consoleError).toHaveBeenCalledWith(
      'PageToLLM Canvas: record view error:',
      expect.objectContaining({ message: 'frame import failed' }),
    );
    expect(dialogs.alert).toHaveBeenCalledWith(expect.stringContaining('Unable to open'));
    consoleError.mockRestore();
  });
});
