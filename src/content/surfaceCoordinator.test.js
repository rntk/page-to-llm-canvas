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
      'PageToLLM record view error:',
      expect.objectContaining({ message: 'frame import failed' }),
    );
    expect(dialogs.alert).toHaveBeenCalledWith(expect.stringContaining('Unable to open'));
    consoleError.mockRestore();
  });
});
