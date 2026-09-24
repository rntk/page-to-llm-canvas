import { describe, it, expect, beforeEach, vi } from 'vitest';

// Neither actionIcon.js nor its only dependency (shared/runtime/contracts.js)
// reads the `chrome` global; the action API is injected, so that is all this
// fake needs to provide.
function makeChromeMock() {
  return {
    action: {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
      setIcon: vi.fn(),
    },
  };
}

function makeRecord(key, overrides = {}) {
  return {
    key,
    sourceUrl: 'https://example.com',
    html: '<p>hello</p>',
    text: '',
    status: 'pending',
    error: null,
    progress: { stage: 'queued', done: 0, total: 0 },
    sentences: [],
    topics: [],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

describe('action icon progress rendering', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('summarizes idle action icon state', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');

    expect(summarizeProcessingState([{ status: 'done' }, { status: 'error' }])).toEqual({
      active: false,
      count: 0,
      ratio: 0,
    });
  });

  it('treats a parked (needs_attention) record as not in-flight', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');

    // The "won't auto-resume" invariant for needs_attention rests entirely on it
    // staying outside the shared in-flight status definition.
    expect(
      summarizeProcessingState([
        { status: 'needs_attention', progress: { stage: 'needs_attention', done: 1, total: 2 } },
      ]),
    ).toEqual({ active: false, count: 0, ratio: 0 });
  });

  it('summarizes indeterminate action icon state for queued work', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');
    const state = summarizeProcessingState([
      { status: 'pending', progress: { stage: 'queued', done: 0, total: 0 } },
    ]);

    expect(state.active).toBe(true);
    expect(state.count).toBe(1);
    expect(state.ratio).toBeGreaterThan(0);
    expect(state.ratio).toBeLessThan(1);
  });

  it('summarizes determinate action icon progress across in-flight records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);

    const { summarizeProcessingState } = await import('./actionIcon.js');
    const state = summarizeProcessingState([
      { status: 'summarizing', progress: { stage: 'summarizing_topics', done: 2, total: 4 } },
      { status: 'splitting', progress: { stage: 'topic_ranges', done: 3, total: 6 } },
      { status: 'done', progress: { stage: 'done', done: 1, total: 1 } },
    ]);

    expect(state.active).toBe(true);
    expect(state.count).toBe(2);
    expect(state.ratio).toBeCloseTo(0.5);
  });

  it('keeps debounce state isolated between injected controllers', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const { createActionIconController } = await import('./actionIcon.js');
    const makeScheduler = () => {
      const callbacks = new Map();
      let nextTimer = 1;
      return {
        callbacks,
        setTimeout: vi.fn((callback) => {
          const timer = nextTimer++;
          callbacks.set(timer, callback);
          return timer;
        }),
        clearTimeout: vi.fn((timer) => callbacks.delete(timer)),
      };
    };
    const schedulerA = makeScheduler();
    const schedulerB = makeScheduler();
    const actionApiA = {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    };
    const makeController = (scheduler, actionApi) =>
      createActionIconController({
        records: vi.fn(async () => [makeRecord('queued')]),
        actionApi,
        assets: { paths: {}, loadBitmap: vi.fn() },
        canvasFactory: vi.fn(),
        scheduler,
        logger: { warn: vi.fn() },
      });
    const controllerA = makeController(schedulerA, actionApiA);
    const controllerB = makeController(schedulerB, {
      setBadgeText: vi.fn(),
      setBadgeBackgroundColor: vi.fn(),
    });

    controllerA.schedule();
    controllerA.schedule();
    controllerB.schedule();

    expect(schedulerA.clearTimeout).toHaveBeenCalledTimes(1);
    expect(schedulerB.clearTimeout).not.toHaveBeenCalled();
    expect(schedulerA.callbacks.size).toBe(1);
    expect(schedulerB.callbacks.size).toBe(1);
    await [...schedulerA.callbacks.values()][0]();
    await vi.waitFor(() => {
      expect(actionApiA.setBadgeText).toHaveBeenCalledWith({ text: '...' });
    });

    controllerA.dispose();
    controllerB.dispose();
  });

  it('updates the toolbar badge and progress icon for in-flight records', async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal('chrome', chromeMock);
    const { ACTION_ICON_PATHS, createActionIconController } = await import('./actionIcon.js');
    const controller = createActionIconController({
      records: vi.fn(async () => [
        makeRecord('busy1', {
          status: 'summarizing',
          progress: { stage: 'summarizing_topics', done: 1, total: 2 },
        }),
      ]),
      actionApi: chromeMock.action,
      assets: { paths: ACTION_ICON_PATHS, loadBitmap: vi.fn(async () => ({})) },
      canvasFactory: (w, h) => ({
        width: w,
        height: h,
        getContext: () => ({
          drawImage: vi.fn(),
          fillStyle: '',
          beginPath: vi.fn(),
          roundRect: vi.fn(),
          fill: vi.fn(),
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        }),
      }),
      scheduler: { setTimeout, clearTimeout },
      logger: { warn: vi.fn() },
    });

    await controller.refresh();
    // vi.waitFor only retries while its callback throws — a callback that
    // merely returns a boolean (the previous form here) resolves on its very
    // first tick regardless of the value, so it never actually waited for the
    // async badge update. Assert (which throws on failure) so it genuinely
    // polls until the badge call lands.
    await vi.waitFor(() => {
      expect(chromeMock.action.setBadgeText.mock.calls.length).toBeGreaterThan(0);
    });

    expect(chromeMock.action.setBadgeBackgroundColor).toHaveBeenCalled();
    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '...' });
    expect(chromeMock.action.setIcon).toHaveBeenCalledWith({
      imageData: expect.objectContaining({
        16: expect.anything(),
        48: expect.anything(),
        96: expect.anything(),
      }),
    });
    controller.dispose();
  });

  it('restores the default icon when the last in-flight record finishes', async () => {
    const chromeMock = makeChromeMock();
    const { ACTION_ICON_PATHS, createActionIconController } = await import('./actionIcon.js');
    const controller = createActionIconController({
      records: vi.fn(async () => [{ status: 'done' }]),
      actionApi: chromeMock.action,
      assets: { paths: ACTION_ICON_PATHS, loadBitmap: vi.fn() },
      canvasFactory: vi.fn(),
      scheduler: { setTimeout, clearTimeout },
      logger: { warn: vi.fn() },
    });

    await controller.refresh();

    expect(chromeMock.action.setBadgeText).toHaveBeenCalledWith({ text: '' });
    expect(chromeMock.action.setIcon).toHaveBeenCalledWith({ path: ACTION_ICON_PATHS });
    controller.dispose();
  });
});

describe('createActionIconDependencies', () => {
  it('loads extension assets through fetch, blob, and createImageBitmap', async () => {
    const { ACTION_ICON_PATHS, createActionIconDependencies } = await import('./actionIcon.js');
    const blob = { type: 'image/png' };
    const bitmap = { width: 16, height: 16 };
    const response = { blob: vi.fn(async () => blob) };
    const globalScope = {
      fetch: vi.fn(async () => response),
      createImageBitmap: vi.fn(async () => bitmap),
    };
    const runtimeApi = { getURL: vi.fn((path) => `extension://${path}`) };
    const dependencies = createActionIconDependencies({
      records: vi.fn(),
      actionApi: {},
      runtimeApi,
      globalScope,
      logger: { warn: vi.fn() },
    });

    await expect(dependencies.assets.loadBitmap(ACTION_ICON_PATHS[16])).resolves.toBe(bitmap);
    expect(runtimeApi.getURL).toHaveBeenCalledWith(ACTION_ICON_PATHS[16]);
    expect(globalScope.fetch).toHaveBeenCalledWith(`extension://${ACTION_ICON_PATHS[16]}`);
    expect(response.blob).toHaveBeenCalledOnce();
    expect(globalScope.createImageBitmap).toHaveBeenCalledWith(blob);
  });

  it('creates a canvas only when both required worker APIs are available', async () => {
    const { createActionIconDependencies } = await import('./actionIcon.js');
    class FakeOffscreenCanvas {
      constructor(width, height) {
        this.width = width;
        this.height = height;
      }
    }
    const baseOptions = {
      records: vi.fn(),
      actionApi: {},
      runtimeApi: {},
      logger: { warn: vi.fn() },
    };
    const supported = createActionIconDependencies({
      ...baseOptions,
      globalScope: { OffscreenCanvas: FakeOffscreenCanvas, createImageBitmap: vi.fn() },
    });
    const missingBitmap = createActionIconDependencies({
      ...baseOptions,
      globalScope: { OffscreenCanvas: FakeOffscreenCanvas },
    });
    const missingCanvas = createActionIconDependencies({
      ...baseOptions,
      globalScope: { createImageBitmap: vi.fn() },
    });

    expect(supported.canvasFactory(16, 24)).toMatchObject({ width: 16, height: 24 });
    expect(missingBitmap.canvasFactory(16, 16)).toBeNull();
    expect(missingCanvas.canvasFactory(16, 16)).toBeNull();
  });

  it('calls timer APIs with the worker global as receiver', async () => {
    const { createActionIconDependencies } = await import('./actionIcon.js');
    expect.assertions(5);
    const globalScope = {
      setTimeout(callback, delay) {
        expect(this).toBe(globalScope);
        expect(callback).toBeTypeOf('function');
        expect(delay).toBe(200);
        return 17;
      },
      clearTimeout(timer) {
        expect(this).toBe(globalScope);
        expect(timer).toBe(17);
      },
    };
    const { scheduler } = createActionIconDependencies({
      records: vi.fn(),
      actionApi: {},
      runtimeApi: {},
      globalScope,
      logger: { warn: vi.fn() },
    });

    const timer = scheduler.setTimeout(() => {}, 200);
    scheduler.clearTimeout(timer);
  });
});
