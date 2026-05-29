import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LLM_ENDPOINT } from "./config.js";

async function getLLM() {
  vi.resetModules();
  return await import("./llm.js");
}

describe("callLLMDirect", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("successfully calls fetch and returns content with <think> tag stripped", async () => {
    const { callLLMDirect } = await getLLM();
    const mockResponse = {
      choices: [
        {
          message: {
            content: "<think>thinking process here</think>This is the final response text.",
          },
        },
      ],
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res).toEqual({
      ok: true,
      content: "This is the final response text.",
    });

    expect(fetch).toHaveBeenCalledWith(
      LLM_ENDPOINT,
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-oss-20B",
          messages: [{ role: "user", content: "hello" }],
          temperature: 0.8,
          cache_prompt: true,
        }),
      })
    );
    expect(console.info).toHaveBeenCalledWith("PageToLLM Canvas LLM request:", expect.any(Object));
    expect(console.info).toHaveBeenCalledWith("PageToLLM Canvas LLM response:", expect.any(Object));

    const requestLog = vi.mocked(console.info).mock.calls.find(c => c[0] === "PageToLLM Canvas LLM request:")[1];
    expect(requestLog).toEqual({
      endpoint: LLM_ENDPOINT,
      model: "gpt-oss-20B",
      promptLength: 5,
      temperature: 0.8,
    });

    const responseLog = vi.mocked(console.info).mock.calls.find(c => c[0] === "PageToLLM Canvas LLM response:")[1];
    expect(responseLog.status).toBe(200);
    expect(responseLog.durationMs).toBeLessThan(1000);
    expect(responseLog.responseLength).toBe(68);
  });

  it("strips various forms of <think> tags", async () => {
    const { callLLMDirect } = await getLLM();
    const variations = [
      "<think>a</think>test",
      "<think class='x'>a</think>test",
      "<THINK>a</THINK>test",
      "<think>\na\n</think>test",
      "<think>a\nb</think>test",
      "<think   >a</think>test",
      "<think attr1=\"a\" attr2=\"b\">thinking</think>test",
      "<think>ab</think>test",
      "<think></think>test",
    ];

    for (const content of variations) {
      const mockResponse = {
        choices: [{ message: { content } }],
      };
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });
      const res = await callLLMDirect({ prompt: "hello" });
      expect(res.content).toBe("test");
    }
  });

  it("returns error on non-ok HTTP status", async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("LLM HTTP 500: Internal server error");
  });

  it("handles res.text() failure on non-ok HTTP status", async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => { throw new Error("read error"); },
    });

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("LLM HTTP 500: ");
  });

  it("slices error response text to 300 characters", async () => {
    const { callLLMDirect } = await getLLM();
    const longText = "a".repeat(400);
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => longText,
    });

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.error).toBe(`LLM HTTP 500: ${"a".repeat(300)}`);
  });

  it("handles invalid json response gracefully", async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => null,
    });
    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Empty LLM response");
  });

  it("returns error on empty or whitespace content", async () => {
    const { callLLMDirect } = await getLLM();
    const mockResponse = {
      choices: [{ message: { content: "   " } }],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Empty LLM response");
  });

  it("returns error when choice.message.content is not a string", async () => {
    const { callLLMDirect } = await getLLM();
    const mockResponse = {
      choices: [{ message: { content: null } }],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Empty LLM response");
  });

  it("handles timeout abort error gracefully", async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockRejectedValue({
      name: "AbortError",
      message: "The operation was aborted.",
    });

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("timed out");
  });

  it("handles generic fetch error", async () => {
    const { callLLMDirect } = await getLLM();
    vi.mocked(fetch).mockRejectedValue(new Error("Connection refused"));

    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Connection refused");
    expect(console.warn).toHaveBeenCalledWith("PageToLLM Canvas LLM request failed:", "Connection refused");
  });

  it("trims the final content", async () => {
    const { callLLMDirect } = await getLLM();
    const mockResponse = {
      choices: [{ message: { content: "  test  " } }],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });
    const res = await callLLMDirect({ prompt: "hello" });
    expect(res.content).toBe("test");
  });

  it("checks custom timeout setup and cleanup", async () => {
    const { callLLMDirect } = await getLLM();
    let aborted = false;
    let timeoutCleared = false;
    
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, delay) => {
      originalSetTimeout(fn, 10);
      return 12345;
    });
    
    const clearSpy = vi.spyOn(globalThis, "clearTimeout").mockImplementation((id) => {
      if (id === 12345) {
        timeoutCleared = true;
      }
      originalClearTimeout(id);
    });

    const mockResponse = {
      choices: [{ message: { content: "Success" } }],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    await callLLMDirect({ prompt: "hello" });
    expect(timeoutSpy).toHaveBeenCalled();
    expect(clearSpy).toHaveBeenCalledWith(12345);
    expect(timeoutCleared).toBe(true);
  });

  it("triggers abort on timeout", async () => {
    const { callLLMDirect } = await getLLM();
    let abortCalled = false;
    
    const originalAbortController = globalThis.AbortController;
    vi.stubGlobal("AbortController", function() {
      const controller = new originalAbortController();
      vi.spyOn(controller, "abort").mockImplementation(() => {
        abortCalled = true;
      });
      return controller;
    });

    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn, delay) => {
      fn(); // trigger immediately
      return 12345;
    });

    vi.mocked(fetch).mockRejectedValue({
      name: "AbortError",
      message: "The operation was aborted.",
    });

    await callLLMDirect({ prompt: "hello" });
    expect(abortCalled).toBe(true);
  });
});

describe("callLLM", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns response content string", async () => {
    const { callLLM } = await getLLM();
    const mockResponse = {
      choices: [{ message: { content: "Response" } }],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const content = await callLLM({ prompt: "hello" });
    expect(content).toBe("Response");
  });

  it("throws error on failure or when response is not ok", async () => {
    const { callLLM } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad request",
    });

    await expect(callLLM({ prompt: "hello" })).rejects.toThrow("LLM HTTP 400: Bad request");
  });

  it("throws error when response content is not a string", async () => {
    const { callLLM } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ choices: [] }), // missing content
    });

    await expect(callLLM({ prompt: "hello" })).rejects.toThrow("Empty LLM response");
  });

  it("throws default message when response.error is falsy", async () => {
    const { callLLM } = await getLLM();
    vi.mocked(fetch).mockRejectedValue("");
    await expect(callLLM({ prompt: "hello" })).rejects.toThrow("LLM request failed");
  });
});

describe("callLLMWithRetry", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // Speed up sleep
    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn) => {
      fn();
      return 0;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds on first attempt", async () => {
    const { callLLMWithRetry } = await getLLM();
    const mockResponse = {
      choices: [{ message: { content: "Success" } }],
    };
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockResponse,
    });

    const content = await callLLMWithRetry({ prompt: "hello" }, 3);
    expect(content).toBe("Success");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries and succeeds on third attempt", async () => {
    const { callLLMWithRetry } = await getLLM();
    const mockResponse = {
      choices: [{ message: { content: "Success" } }],
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Error 1",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Error 2",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      });

    const content = await callLLMWithRetry({ prompt: "hello" }, 3);
    expect(content).toBe("Success");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("fails after exhausting max retries and does not sleep on the last attempt", async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(setTimeout).mockClear();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Error",
    });

    await expect(callLLMWithRetry({ prompt: "hello" }, 2)).rejects.toThrow("LLM HTTP 500: Error");
    expect(fetch).toHaveBeenCalledTimes(2);
    // 2 abort timeouts in callLLMDirect + 1 sleep in callLLMWithRetry
    expect(setTimeout).toHaveBeenCalledTimes(3);
    // Delay values check: abort timeout (120000ms) and retry backoff sleep (1000ms)
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 120000);
    expect(setTimeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(console.warn).toHaveBeenCalledWith("PageToLLM Canvas LLM attempt failed:", {
      attempt: 1,
      maxRetries: 2,
      error: "LLM HTTP 500: Error",
    });
  });

  it("applies exponential backoff delay values on successive retries", async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(setTimeout).mockClear();
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Error 1",
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Error 2",
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Success" } }] }),
      });

    await callLLMWithRetry({ prompt: "hello" }, 3);
    
    // Let's filter setTimeout calls that are for the retry backoff.
    // The abort timeouts are 120000.
    const backoffDelays = vi.mocked(setTimeout).mock.calls
      .map(c => c[1])
      .filter(d => d !== 120000);
      
    expect(backoffDelays).toEqual([1000, 2000]);
  });

  it("handles nullish error in callLLMWithRetry", async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch)
      .mockRejectedValueOnce(null)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: "Success" } }] }),
      });

    await callLLMWithRetry({ prompt: "hello" }, 2);
    expect(console.warn).toHaveBeenCalledWith(
      "PageToLLM Canvas LLM attempt failed:",
      {
        attempt: 1,
        maxRetries: 2,
        error: "null",
      }
    );
  });

  it("fails immediately if maxRetries is 0 or 1", async () => {
    const { callLLMWithRetry } = await getLLM();
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Error",
    });

    await expect(callLLMWithRetry({ prompt: "hello" }, 1)).rejects.toThrow("LLM HTTP 500: Error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("parallelMap", () => {
  it("maps elements in parallel under concurrency limit", async () => {
    const { parallelMap } = await getLLM();
    const items = [1, 2, 3, 4, 5];
    const log = [];
    const fn = async (x) => {
      log.push(`start ${x}`);
      await new Promise((r) => setTimeout(r, 10));
      log.push(`end ${x}`);
      return x * 2;
    };

    const res = await parallelMap(items, 2, fn);
    expect(res).toEqual([2, 4, 6, 8, 10]);
    expect(log[0]).toBe("start 1");
    expect(log[1]).toBe("start 2");

    // With limit 2, we expect at most 2 items to start initially.
    // So the 3rd element cannot start before at least one of the first two ends.
    const start3Index = log.indexOf("start 3");
    const end1Index = log.indexOf("end 1");
    const end2Index = log.indexOf("end 2");
    expect(start3Index).toBeGreaterThan(Math.min(end1Index, end2Index));
  });

  it("handles empty items array", async () => {
    const { parallelMap } = await getLLM();
    const res = await parallelMap([], 2, async (x) => x);
    expect(res).toEqual([]);
  });

  it("allocates array of exactly items length", async () => {
    const { parallelMap } = await getLLM();
    const items = [10, 20];
    const res = await parallelMap(items, 5, async (x) => x);
    expect(res).toHaveLength(2);
    expect(res).toEqual([10, 20]);
  });
});
