// Provider client SDKs for the PageToLLM Canvas pipeline.
//
// JS port of the clients in `example/llm`, scoped down to what the extension
// pipeline actually exercises: a single `{ prompt, temperature } -> text`
// completion. Tool-calls, message history, and OpenAI's Responses API from the
// reference implementation are intentionally omitted.
//
// Every client exposes the same shape:
//   complete({ prompt, temperature?, signal? }) -> Promise<{ content, endpoint, model }>
// and throws an Error (message reused verbatim in callLLMDirect) on failure.

import { ProviderType } from './providers.js';

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
  cachePrompt = false,
  promptCacheKey = '',
  guardTemperature = false,
}) {
  return {
    async complete({ prompt, temperature = 0.8, signal }) {
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
      if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
      if (cachePrompt) body.cache_prompt = true;

      console.log('LLM client raw prompt:', prompt);
      console.log('LLM client request:', { endpoint, body });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(await readErrorText(res));

      const data = await res.json();
      console.log('LLM client raw response data:', data);
      const content = data?.choices?.[0]?.message?.content;
      const cleaned = typeof content === 'string' ? stripThink(content) : '';
      if (!cleaned) throw new Error('Empty LLM response');
      return { content: cleaned, endpoint, model };
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
function anthropicClient({ apiKey, model }) {
  return {
    async complete({ prompt, temperature, signal }) {
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
      if (typeof temperature === 'number') body.temperature = temperature;

      console.log('LLM client raw prompt:', prompt);
      console.log('LLM client request:', { endpoint, body });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) throw new Error(await readErrorText(res));

      const data = await res.json();
      console.log('LLM client raw response data:', data);
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const content = blocks
        .filter((b) => b?.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('\n')
        .trim();
      if (!content) throw new Error('Empty LLM response');
      return { content, endpoint, model };
    },
  };
}

/**
 * Creates a completion client for a stored provider entry.
 * @param {{type: string, model: string, token?: string, url?: string}} provider
 * @returns {{complete: (opts: {prompt: string, temperature?: number, signal?: AbortSignal}) => Promise<{content: string, endpoint: string, model: string}>}}
 */
export function createClient(provider) {
  if (!provider || typeof provider !== 'object') {
    throw new Error('Provider is required');
  }
  const { type, model, token, url } = provider;
  switch (type) {
    case ProviderType.OPENAI:
      return openAICompatibleClient({
        baseUrl: 'https://api.openai.com/v1',
        apiKey: token,
        model,
        promptCacheKey: OPENAI_PROMPT_CACHE_KEY,
        guardTemperature: true,
      });
    case ProviderType.DEEPSEEK:
      return openAICompatibleClient({
        baseUrl: 'https://api.deepseek.com/chat/completions',
        apiKey: token,
        model,
      });
    case ProviderType.OPENROUTER:
      return openAICompatibleClient({
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: token,
        model,
      });
    case ProviderType.OPENAI_COMP:
      if (!url) throw new Error('OpenAI-compatible provider requires a base URL');
      return openAICompatibleClient({ baseUrl: url, apiKey: token, model, cachePrompt: true });
    case ProviderType.ANTHROPIC:
      return anthropicClient({ apiKey: token, model });
    default:
      throw new Error(`Unsupported provider type: ${type}`);
  }
}
