// Provider client SDKs for the PageToLLM Canvas pipeline.
//
// JS port of the clients in `example/llm`, scoped down to what the extension
// pipeline actually exercises: a single `{ prompt, temperature } -> text`
// completion. Tool-calls, message history, and OpenAI's Responses API from the
// reference implementation are intentionally omitted.
//
// Every client exposes the same shape:
//   complete({ prompt, temperature?, signal?, verboseLogs? }) ->
//     Promise<{ content, endpoint, model, provider, usage? }>
// and throws an Error (message reused verbatim in callLLMDirect) on failure.
// Raw prompt/request/response dumps and cache-usage stats only log when
// `verboseLogs` is true (set from the options "verbose pipeline logs" toggle).

import { ProviderType, ServiceTier } from './providers.js';

const THINK_TAG_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const OPENAI_PROMPT_CACHE_KEY = 'pagetollm-canvas';
const ANTHROPIC_CACHE_CONTROL = Object.freeze({ type: 'ephemeral' });
const ANTHROPIC_CACHE_PREFIX_MARKERS = Object.freeze(['\n<content>\n', '\n<text>']);

/** @param {string} text */
export function stripThink(text) {
  return text.replace(THINK_TAG_RE, '').trim();
}

/**
 * Builds the chat-completions URL from a user-supplied base. Tolerates a base
 * given as a host, a host + `/v1`, or a full `/chat/completions` URL.
 * @param {string} base
 */
export function buildChatCompletionsUrl(base) {
  const trimmed = String(base || '')
    .trim()
    .replace(/\/+$/, '');
  if (!trimmed) throw new Error('Provider URL is required');
  if (/\/chat\/completions$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/chat/completions`;
  return `${trimmed}/v1/chat/completions`;
}

function isLocalhostUrl(url) {
  try {
    const parsed = new URL(url);
    return ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  } catch (_) {
    return false;
  }
}

function assertSafeTokenTransport(endpoint, apiKey) {
  if (!apiKey) return;
  let parsed;
  try {
    parsed = new URL(endpoint);
  } catch (_) {
    throw new Error('Provider URL must be a valid URL when a token is configured');
  }
  if (parsed.protocol === 'https:' || isLocalhostUrl(endpoint)) return;
  throw new Error('Refusing to send an API token to a non-HTTPS provider URL');
}

async function readErrorText(res) {
  const txt = await res.text().catch(() => '');
  return `LLM HTTP ${res.status}: ${txt.slice(0, 300)}`;
}

// Models that reject the `temperature` parameter (mirrors the guard in
// example/llm/openai_client.py). Sending temperature to these yields a 400.
const NO_TEMPERATURE_MODELS = new Set(['gpt-5-mini', 'gpt-5-nano']);

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function roundedPercent(part, total) {
  if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return undefined;
  return Math.round((part / total) * 1000) / 10;
}

/**
 * Normalizes the usage fields returned by OpenAI-compatible APIs, DeepSeek,
 * Anthropic, and llama.cpp. Missing fields stay absent so callers can
 * distinguish an actual zero from a provider that did not report a metric.
 *
 * `inputTokens` includes cached and cache-creation tokens. Anthropic reports
 * those separately, while OpenAI-compatible APIs include them in
 * `prompt_tokens` already.
 *
 * @param {string} provider
 * @param {unknown} data
 * @returns {{
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   totalTokens?: number,
 *   reasoningTokens?: number,
 *   cacheReadTokens?: number,
 *   cacheWriteTokens?: number,
 *   cacheMissTokens?: number,
 * } | undefined}
 */
export function extractLlmUsage(provider, data) {
  const response = data && typeof data === 'object' ? data : {};
  const usage = response?.usage && typeof response.usage === 'object' ? response.usage : {};
  const promptTokens = finiteNumber(usage.prompt_tokens);
  const anthropicInputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.completion_tokens ?? usage.output_tokens);
  const reportedTotalTokens = finiteNumber(usage.total_tokens);
  const reasoningTokens = finiteNumber(
    usage.completion_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.output_tokens_details?.thinking_tokens,
  );
  const openAiCachedTokens = finiteNumber(
    usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens,
  );
  const openAiCacheWriteTokens = finiteNumber(
    usage.prompt_tokens_details?.cache_write_tokens ??
      usage.input_tokens_details?.cache_write_tokens,
  );
  const deepSeekHitTokens = finiteNumber(usage.prompt_cache_hit_tokens);
  const deepSeekMissTokens = finiteNumber(usage.prompt_cache_miss_tokens);
  const anthropicCacheReadTokens = finiteNumber(usage.cache_read_input_tokens);
  const anthropicCacheCreationTokens = finiteNumber(usage.cache_creation_input_tokens);
  const llamaCacheTokens = finiteNumber(response?.timings?.cache_n);
  const llamaPromptEvalTokens = finiteNumber(response?.timings?.prompt_n);
  const llamaOutputTokens = finiteNumber(response?.timings?.predicted_n);

  let inputTokens = promptTokens ?? anthropicInputTokens;
  const normalizedOutputTokens = outputTokens ?? llamaOutputTokens;
  let cacheReadTokens;
  let cacheWriteTokens;
  let cacheMissTokens;

  if (deepSeekHitTokens !== undefined || deepSeekMissTokens !== undefined) {
    cacheReadTokens = deepSeekHitTokens;
    cacheMissTokens = deepSeekMissTokens;
    inputTokens ??= (deepSeekHitTokens ?? 0) + (deepSeekMissTokens ?? 0);
  } else if (provider === 'anthropic') {
    cacheReadTokens = anthropicCacheReadTokens;
    cacheWriteTokens = anthropicCacheCreationTokens;
    cacheMissTokens = anthropicInputTokens;
    if (
      anthropicInputTokens !== undefined ||
      anthropicCacheReadTokens !== undefined ||
      anthropicCacheCreationTokens !== undefined
    ) {
      inputTokens =
        (anthropicInputTokens ?? 0) +
        (anthropicCacheReadTokens ?? 0) +
        (anthropicCacheCreationTokens ?? 0);
    }
  } else if (llamaCacheTokens !== undefined || llamaPromptEvalTokens !== undefined) {
    cacheReadTokens = llamaCacheTokens;
    cacheMissTokens = llamaPromptEvalTokens;
    inputTokens ??= (llamaCacheTokens ?? 0) + (llamaPromptEvalTokens ?? 0);
  } else if (openAiCachedTokens !== undefined) {
    cacheReadTokens = openAiCachedTokens;
    cacheWriteTokens = openAiCacheWriteTokens;
    cacheMissTokens =
      promptTokens !== undefined
        ? Math.max(promptTokens - openAiCachedTokens - (openAiCacheWriteTokens ?? 0), 0)
        : undefined;
  } else if (openAiCacheWriteTokens !== undefined) {
    cacheWriteTokens = openAiCacheWriteTokens;
    cacheMissTokens =
      promptTokens !== undefined ? Math.max(promptTokens - openAiCacheWriteTokens, 0) : undefined;
  }

  const totalTokens =
    reportedTotalTokens ??
    (inputTokens !== undefined || normalizedOutputTokens !== undefined
      ? (inputTokens ?? 0) + (normalizedOutputTokens ?? 0)
      : undefined);
  const normalized = {
    inputTokens,
    outputTokens: normalizedOutputTokens,
    totalTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cacheMissTokens,
  };
  if (Object.values(normalized).every((value) => value === undefined)) return undefined;
  return Object.fromEntries(Object.entries(normalized).filter(([, value]) => value !== undefined));
}

function logCacheUsage(provider, data, verboseLogs) {
  if (!verboseLogs) return;
  const usage = data?.usage || {};
  const normalized = extractLlmUsage(provider, data) || {};
  const totalCacheLookupTokens =
    normalized.cacheReadTokens !== undefined ||
    normalized.cacheWriteTokens !== undefined ||
    normalized.cacheMissTokens !== undefined
      ? (normalized.cacheReadTokens ?? 0) +
        (normalized.cacheWriteTokens ?? 0) +
        (normalized.cacheMissTokens ?? 0)
      : undefined;

  console.log('LLM cache usage:', {
    provider,
    cache_hit_tokens: normalized.cacheReadTokens,
    cache_miss_tokens: normalized.cacheMissTokens,
    cache_hit_rate_percent: roundedPercent(normalized.cacheReadTokens, totalCacheLookupTokens),
    prompt_tokens: normalized.inputTokens,
    cache_creation_tokens: normalized.cacheWriteTokens,
    raw_usage: usage,
    llama_timings: data?.timings,
  });
}

/** @param {boolean} [verboseLogs] */
function logClientVerbose(verboseLogs, ...args) {
  if (!verboseLogs) return;
  console.log(...args);
}

/**
 * OpenAI-compatible `/chat/completions` client. Covers openai, openrouter and
 * openai_comp (custom URL). `cachePrompt` adds the llama.cpp-specific
 * `cache_prompt` flag — only safe for local OpenAI-compatible servers.
 * `guardTemperature` drops the temperature field for models that reject it
 * (OpenAI-hosted only).
 */
function openAICompatibleClient({
  baseUrl,
  apiKey,
  model,
  serviceTier,
  cachePrompt = false,
  promptCacheKey = '',
  guardTemperature = false,
  providerLabel = 'openai-compatible',
}) {
  return {
    async complete({ prompt, temperature = 0.8, signal, verboseLogs = false }) {
      const endpoint = buildChatCompletionsUrl(baseUrl);
      assertSafeTokenTransport(endpoint, apiKey);
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const body = {
        model,
        messages: [{ role: 'user', content: prompt }],
      };
      if (!(guardTemperature && NO_TEMPERATURE_MODELS.has(model))) {
        body.temperature = temperature;
      }
      if (serviceTier) body.service_tier = serviceTier;
      if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
      if (cachePrompt) body.cache_prompt = true;

      logClientVerbose(verboseLogs, 'LLM client raw prompt:', prompt);
      logClientVerbose(verboseLogs, 'LLM client request:', { endpoint, body });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(await readErrorText(res));

      const data = await res.json();
      logClientVerbose(verboseLogs, 'LLM client raw response data:', data);
      logCacheUsage(providerLabel, data, verboseLogs);
      const content = data?.choices?.[0]?.message?.content;
      const cleaned = typeof content === 'string' ? stripThink(content) : '';
      if (!cleaned) throw new Error('Empty LLM response');
      return {
        content: cleaned,
        endpoint,
        model,
        provider: providerLabel,
        usage: extractLlmUsage(providerLabel, data),
      };
    },
  };
}

function anthropicCacheableContent(prompt) {
  const marker = ANTHROPIC_CACHE_PREFIX_MARKERS.find((oneMarker) => prompt.includes(oneMarker));
  if (!marker) return prompt;

  const splitAt = prompt.indexOf(marker) + marker.length;
  const prefix = prompt.slice(0, splitAt);
  const suffix = prompt.slice(splitAt);
  if (!prefix || !suffix) return prompt;

  return [
    { type: 'text', text: prefix, cache_control: ANTHROPIC_CACHE_CONTROL },
    { type: 'text', text: suffix },
  ];
}

/** Anthropic Messages API client. */
function anthropicClient({ apiKey, model, serviceTier }) {
  return {
    async complete({ prompt, temperature, signal, verboseLogs = false }) {
      const endpoint = 'https://api.anthropic.com/v1/messages';
      const headers = {
        'Content-Type': 'application/json',
        'x-api-key': apiKey || '',
        'anthropic-version': '2023-06-01',
        // Required for direct browser/extension calls to the Anthropic API.
        'anthropic-dangerous-direct-browser-access': 'true',
      };
      // No top-level cache_control: anthropicCacheableContent already places the
      // breakpoint on the stable prefix. Top-level auto-caching would add a
      // second breakpoint on the *last* block (the dynamic suffix, or the whole
      // prompt when there's no marker), paying the cache-write premium on volatile
      // content that's never read back.
      const body = {
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: anthropicCacheableContent(prompt) }],
      };
      const anthropicServiceTier = toAnthropicServiceTier(serviceTier);
      if (anthropicServiceTier) body.service_tier = anthropicServiceTier;
      if (typeof temperature === 'number') body.temperature = temperature;

      logClientVerbose(verboseLogs, 'LLM client raw prompt:', prompt);
      logClientVerbose(verboseLogs, 'LLM client request:', { endpoint, body });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(await readErrorText(res));

      const data = await res.json();
      logClientVerbose(verboseLogs, 'LLM client raw response data:', data);
      logCacheUsage('anthropic', data, verboseLogs);
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const content = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!content) throw new Error('Empty LLM response');
      return {
        content,
        endpoint,
        model,
        provider: 'anthropic',
        usage: extractLlmUsage('anthropic', data),
      };
    },
  };
}

function toAnthropicServiceTier(serviceTier) {
  if (serviceTier === ServiceTier.PRIORITY || serviceTier === ServiceTier.AUTO) return 'auto';
  if (serviceTier === ServiceTier.DEFAULT) return 'standard_only';
  return undefined;
}

/**
 * Creates a completion client for a stored provider entry.
 * @param {{type: string, model: string, token?: string, url?: string}} provider
 * @returns {{complete: (opts: {prompt: string, temperature?: number, signal?: AbortSignal, verboseLogs?: boolean}) => Promise<{content: string, endpoint: string, model: string, provider: string, usage?: Record<string, number>}>}}
 */
export function createClient(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Provider is required');
  }
  const { type, model, token, url, serviceTier } = provider;
  switch (type) {
    case ProviderType.OPENAI:
      return openAICompatibleClient({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: token,
        model,
        serviceTier,
        promptCacheKey: OPENAI_PROMPT_CACHE_KEY,
        guardTemperature: true,
        providerLabel: 'openai',
      });
    case ProviderType.DEEPSEEK:
      return openAICompatibleClient({
        baseUrl: 'https://api.deepseek.com/chat/completions',
        apiKey: token,
        model,
        providerLabel: 'deepseek',
      });
    case ProviderType.OPENROUTER:
      return openAICompatibleClient({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: token,
        model,
        serviceTier,
        providerLabel: 'openrouter',
      });
    case ProviderType.OPENAI_COMP:
      if (!url) throw new Error('OpenAI-compatible provider requires a base URL');
      return openAICompatibleClient({
        baseUrl: url,
        apiKey: token,
        model,
        cachePrompt: true,
        providerLabel: 'openai-compatible',
      });
    case ProviderType.ANTHROPIC:
      return anthropicClient({ apiKey: token, model, serviceTier });
    default:
      throw new Error(`Unsupported provider type: ${type}`);
  }
}
