import { describe, expect, it, vi } from 'vitest';
import { ACTION_ICON_PATHS } from '../../../worker/actionIcon.js';
import { createActionIconDependencies } from './actionIconDependencies.js';

describe('createActionIconDependencies', () => {
  it('loads extension assets through fetch, blob, and createImageBitmap', async () => {
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

  it('creates a canvas only when both required worker APIs are available', () => {
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

  it('calls timer APIs with the worker global as receiver', () => {
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
