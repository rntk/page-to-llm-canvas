// OpenAI-compatible LLM client for the PageToLLM Canvas pipeline.
// Runs in the service worker context; fetches the LLM endpoint directly.

import { LLM_ENDPOINT, LLM_REQUEST_TIMEOUT_MS, DEFAULT_MODEL } from "./config.js";

const THINK_TAG_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;

/**
 * Makes a single direct fetch to the LLM endpoint.
 * Returns `{ok, content?, error?}` — the same shape used by the background
 * message handler so it can delegate here too.
 *
 * @param {{prompt: string, temperature?: number, model?: string}} options
 * @returns {Promise<{ok: boolean, content?: string, error?: string}>}
 */
export async function callLLMDirect({ prompt, temperature = 0.8, model = DEFAULT_MODEL }) {
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    temperature,
    cache_prompt: true,
  };
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), LLM_REQUEST_TIMEOUT_MS);
  console.info("PageToLLM Canvas LLM request:", {
    endpoint: LLM_ENDPOINT,
    model,
    promptLength: prompt.length,
    temperature,
  });

  try {
    const res = await fetch(LLM_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      return { ok: false, error: `LLM HTTP ${res.status}: ${txt.slice(0, 300)}` };
    }
    const data = await res.json();
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return { ok: false, error: "Empty LLM response" };
    }
    console.info("PageToLLM Canvas LLM response:", {
      status: res.status,
      durationMs: Date.now() - startedAt,
      responseLength: content.length,
    });
    return { ok: true, content: content.replace(THINK_TAG_RE, "").trim() };
  } catch (e) {
    const message =
      e && e.name === "AbortError"
        ? `LLM request timed out after ${LLM_REQUEST_TIMEOUT_MS}ms`
        : (e && e.message) || String(e);
    console.warn("PageToLLM Canvas LLM request failed:", message);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {{prompt: string, temperature?: number, model?: string}} options
 * @returns {Promise<string>}
 */
export async function callLLM(options) {
  const response = await callLLMDirect(options);
  if (!response.ok || typeof response.content !== "string") {
    const message = response.error || "LLM request failed";
    throw new Error(message);
  }
  return response.content;
}

/**
 * @param {{prompt: string, temperature?: number, model?: string}} opts
 * @param {number} [maxRetries]
 * @returns {Promise<string>}
 */
export async function callLLMWithRetry(opts, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await callLLM(opts);
    } catch (e) {
      lastErr = e;
      console.warn("PageToLLM Canvas LLM attempt failed:", {
        attempt: attempt + 1,
        maxRetries,
        error: (e && e.message) || String(e),
      });
      if (attempt === maxRetries - 1) break;
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

/**
 * @template T,U
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T, index: number) => Promise<U>} fn
 * @returns {Promise<U[]>}
 */
export async function parallelMap(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length || 1)).fill(0).map(async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}
