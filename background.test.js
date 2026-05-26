import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("./worker/orchestrator.js", () => ({
  runPipeline: vi.fn(() => new Promise((resolve) => setTimeout(resolve, 10))),
}));

const STALE_MS = 10 * 60 * 1000;

function makeChromeMock() {
  const store = new Map();
  const runtime = { lastError: null };

  const chromeLocal = {
    _store: store,
    get: vi.fn((keys, cb) => {
      runtime.lastError = null;
      const result = {};
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) {
        if (store.has(k)) result[k] = store.get(k);
      }
      cb(result);
    }),
    set: vi.fn((items, cb) => {
      runtime.lastError = null;
      for (const [k, v] of Object.entries(items)) store.set(k, v);
      cb();
    }),
    remove: vi.fn((keys, cb) => {
      runtime.lastError = null;
      const keyList = Array.isArray(keys) ? keys : [keys];
      for (const k of keyList) store.delete(k);
      cb();
    }),
  };

  return {
    storage: {
      local: chromeLocal,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    runtime: {
      ...runtime,
      sendMessage: vi.fn(),
      onMessage: { addListener: vi.fn() },
    },
  };
}

function seedRecord(chromeMock, rec) {
  const sKey = `pagetollm:rec:${rec.key}`;
  chromeMock.storage.local._store.set(sKey, rec);
  const idx = chromeMock.storage.local._store.get("pagetollm:index") || { keys: [] };
  if (!idx.keys.includes(rec.key)) idx.keys.unshift(rec.key);
  chromeMock.storage.local._store.set("pagetollm:index", idx);
}

function makeRecord(key, overrides = {}) {
  return {
    key,
    sourceUrl: "https://example.com",
    html: "<p>hello</p>",
    text: "",
    status: "pending",
    error: null,
    progress: { stage: "queued", done: 0, total: 0 },
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

describe("background pipeline lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("submit starts a new job for a fresh record", async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import("./background.js");
    _resetJobRegistry();

    const result = await handleSubmit({
      html: "<p>hello</p>",
      sourceUrl: "https://example.com",
    });

    expect(result.ok).toBe(true);
    expect(result.key).toBeDefined();

    const { runPipeline } = await import("./worker/orchestrator.js");
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith(result.key);
  });

  it("does not start duplicate jobs for the same key", async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const { handleSubmit, _resetJobRegistry } = await import("./background.js");
    _resetJobRegistry();

    const result1 = await handleSubmit({
      html: "<p>hello</p>",
      sourceUrl: "https://example.com",
    });
    const result2 = await handleSubmit({
      html: "<p>hello</p>",
      sourceUrl: "https://example.com",
    });

    expect(result1.key).toBe(result2.key);

    const { runPipeline } = await import("./worker/orchestrator.js");
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it("returns existing done record without restarting", async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const rec = makeRecord("done1", { status: "done", updatedAt: Date.now() });
    seedRecord(chromeMock, rec);

    const { handleSubmit, _resetJobRegistry } = await import("./background.js");
    _resetJobRegistry();

    const result = await handleSubmit({
      html: "<p>hello</p>",
      sourceUrl: "https://example.com",
    });

    expect(result.ok).toBe(true);
    expect(result.key).toBe("done1");

    const { runPipeline } = await import("./worker/orchestrator.js");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("resumes a stale in-flight record", async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const rec = makeRecord("stale1", {
      status: "splitting",
      updatedAt: Date.now() - STALE_MS - 1000,
    });
    seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import("./background.js");
    _resetJobRegistry();

    await startPipeline("stale1");

    const { runPipeline } = await import("./worker/orchestrator.js");
    expect(runPipeline).toHaveBeenCalledTimes(1);
    expect(runPipeline).toHaveBeenCalledWith("stale1");
  });

  it("does not duplicate an already-running job", async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const rec = makeRecord("running1", { status: "pending" });
    seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import("./background.js");
    _resetJobRegistry();

    // Start a job but do not await its completion.
    startPipeline("running1");
    // Immediately try to start again.
    await startPipeline("running1");

    const { runPipeline } = await import("./worker/orchestrator.js");
    expect(runPipeline).toHaveBeenCalledTimes(1);
  });

  it("does not start a job for done records", async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const rec = makeRecord("done2", { status: "done" });
    seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import("./background.js");
    _resetJobRegistry();

    await startPipeline("done2");

    const { runPipeline } = await import("./worker/orchestrator.js");
    expect(runPipeline).not.toHaveBeenCalled();
  });

  it("does not start a job for error records", async () => {
    const chromeMock = makeChromeMock();
    vi.stubGlobal("chrome", chromeMock);

    const rec = makeRecord("err1", { status: "error", error: "boom" });
    seedRecord(chromeMock, rec);

    const { startPipeline, _resetJobRegistry } = await import("./background.js");
    _resetJobRegistry();

    await startPipeline("err1");

    const { runPipeline } = await import("./worker/orchestrator.js");
    expect(runPipeline).not.toHaveBeenCalled();
  });
});
