// Provider client SDKs for the PageToLLM Canvas pipeline.
//
// JS port of the clients in `example/llm`. The pipeline still uses the simple
// `{ prompt, temperature } -> text` form, while article chat passes complete
// message history and function tools. Tools and messages use one strict
// internal shape everywhere ({name, description, parameters} in,
// {id, name, arguments-object} out); each client serializes that internal
// shape to its provider's wire format. The converters that do this
// serialization (toProviderMessage, toProviderTool, toAnthropicMessages,
// toAnthropicTool) accept ONLY the internal shape — they are an internal
// seam whose sole producer is src/chat/articleChat.js, so they do not need to
// tolerate (and must not silently accept) OpenAI/Anthropic wire shapes as
// input. Tolerance for provider quirks is applied only at the external
// boundary: parsing the HTTP responses that come back from each provider
// (see parseToolArguments/normalizeToolCalls below).
//
// Every client exposes the same shape:
//   complete({ prompt, temperature?, signal?, verboseLogs? }) ->
//     Promise<{ content, endpoint, model, provider, usage? }>
// and throws an Error (message reused verbatim in callLLMDirect) on failure.
// Raw prompt/request/response dumps and cache-usage stats only log when
// `verboseLogs` is true (set from the options "verbose pipeline logs" toggle).

import { ProviderType, ServiceTier } from './providers.js';

const THINK_TAG_RE = /<think\b[^>]*>[\s\S]*?<\/think>/gi;
const THINK_TAG_CAPTURE_RE = /<think\b[^>]*>([\s\S]*?)<\/think>/gi;
const OPENAI_PROMPT_CACHE_KEY = 'pagetollm-canvas';
const ANTHROPIC_CACHE_CONTROL = Object.freeze({ type: 'ephemeral' });
const ANTHROPIC_CACHE_PREFIX_MARKERS = Object.freeze(['\n<content>\n', '\n<text>']);

/** @param {string} text */
export function stripThink(text) {
  return text.replace(THINK_TAG_RE, '').trim();
}

// Inbound-only: parses tool-call arguments from a provider HTTP response.
// OpenAI-compatible APIs return `arguments` as a JSON string; this is the
// external boundary where tolerance belongs (see file header comment).
function parseToolArguments(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') {
    throw new Error('Tool-call arguments must be a JSON object');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid tool-call arguments JSON: ${error.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Tool-call arguments must decode to a JSON object');
  }
  return parsed;
}

// Inbound-only: normalizes tool calls from a provider HTTP response into the
// internal `{id, name, arguments}` shape. See file header comment.
function normalizeToolCalls(rawToolCalls) {
  if (!Array.isArray(rawToolCalls)) return [];
  return rawToolCalls.map((rawCall) => {
    const call = rawCall && typeof rawCall === 'object' ? rawCall : {};
    const fn = call.function && typeof call.function === 'object' ? call.function : call;
    return {
      id:
        typeof call.id === 'string'
          ? call.id
          : typeof call.call_id === 'string'
            ? call.call_id
            : null,
      name: typeof fn.name === 'string' ? fn.name : '',
      arguments: parseToolArguments(fn.arguments),
    };
  });
}

function responseTextAndReasoning(message) {
  const rawContent = typeof message?.content === 'string' ? message.content : '';
  const reasoningParts = [];
  for (const key of ['reasoning', 'reasoning_content', 'thinking']) {
    const value = message?.[key];
    if (typeof value === 'string' && value.trim()) reasoningParts.push(value.trim());
  }
  for (const match of rawContent.matchAll(THINK_TAG_CAPTURE_RE)) {
    if (match[1]?.trim()) reasoningParts.push(match[1].trim());
  }
  return {
    content: stripThink(rawContent),
    reasoning: reasoningParts.join('\n\n').trim() || undefined,
  };
}

// Wraps the internal `{name, description, parameters}` tool shape into
// OpenAI's `{type: 'function', function: {...}}` wire format. Internal-input
// only — see file header comment.
function toProviderTool(tool) {
  return {
    type: 'function',
    function: {
      name: tool?.name || '',
      description: tool?.description || '',
      parameters: tool?.parameters || { type: 'object', properties: {} },
    },
  };
}

// Converts one internal message to OpenAI's wire format. Internal-input
// only — see file header comment.
function toProviderMessage(message) {
  const output = {
    role: message?.role || 'user',
    content: typeof message?.content === 'string' ? message.content : '',
  };
  const toolCallId = message?.toolCallId;
  if (output.role === 'tool' && toolCallId) output.tool_call_id = toolCallId;
  const reasoning = message?.reasoning;
  if (typeof reasoning === 'string' && reasoning) output.reasoning_content = reasoning;
  const toolCalls = message?.toolCalls;
  if (Array.isArray(toolCalls) && toolCalls.length) {
    output.tool_calls = toolCalls.map((toolCall) => ({
      id: toolCall?.id || undefined,
      type: 'function',
      function: {
        name: toolCall?.name || '',
        arguments: JSON.stringify(toolCall?.arguments || {}),
      },
    }));
  }
  return output;
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

/**
 * Parses a `Retry-After` header value into milliseconds. Accepts either an
 * integer-seconds value or an HTTP-date value; returns undefined when the
 * header is absent or does not parse. A past HTTP-date floors at 0 rather
 * than going negative.
 * @param {string | null | undefined} headerValue
 * @returns {number | undefined}
 */
export function parseRetryAfterMs(headerValue) {
  if (!headerValue) return undefined;
  const trimmed = String(headerValue).trim();
  if (/^\d+$/.test(trimmed)) {
    return Number(trimmed) * 1000;
  }
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    return Math.max(dateMs - Date.now(), 0);
  }
  return undefined;
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
    async complete({
      prompt = '',
      messages,
      tools,
      toolChoice,
      parallelToolCalls,
      temperature = 0.8,
      signal,
      verboseLogs = false,
    }) {
      const endpoint = buildChatCompletionsUrl(baseUrl);
      assertSafeTokenTransport(endpoint, apiKey);
      const headers = { 'Content-Type': 'application/json' };
      if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
      const body = {
        model,
        messages:
          Array.isArray(messages) && messages.length
            ? messages.map(toProviderMessage)
            : [{ role: 'user', content: prompt }],
      };
      if (!(guardTemperature && NO_TEMPERATURE_MODELS.has(model))) {
        body.temperature = temperature;
      }
      if (serviceTier) body.service_tier = serviceTier;
      if (promptCacheKey) body.prompt_cache_key = promptCacheKey;
      if (cachePrompt) body.cache_prompt = true;
      const hasTools = Array.isArray(tools) && tools.length > 0;
      if (hasTools) body.tools = tools.map(toProviderTool);
      if (hasTools && toolChoice !== undefined) body.tool_choice = toolChoice;
      if (hasTools && parallelToolCalls !== undefined) {
        body.parallel_tool_calls = parallelToolCalls;
      }

      logClientVerbose(verboseLogs, 'LLM client raw prompt:', prompt);
      logClientVerbose(verboseLogs, 'LLM client request:', { endpoint, body });

      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal,
      });
      if (!res.ok) {
        const error = new Error(await readErrorText(res));
        error.status = res.status;
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('Retry-After'));
        if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
        throw error;
      }

      const data = await res.json();
      logClientVerbose(verboseLogs, 'LLM client raw response data:', data);
      logCacheUsage(providerLabel, data, verboseLogs);
      const message = data?.choices?.[0]?.message;
      const { content, reasoning } = responseTextAndReasoning(message);
      const toolCalls = normalizeToolCalls(message?.tool_calls);
      if (!content && toolCalls.length === 0) throw new Error('Empty LLM response');
      return {
        content,
        reasoning,
        toolCalls,
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

/**
 * Anthropic tool definitions use `input_schema` instead of OpenAI's
 * `parameters` and have no `function` wrapper. Builds from the internal
 * `{name, description, parameters}` shape only — see file header comment.
 */
function toAnthropicTool(tool) {
  return {
    name: tool?.name || '',
    description: tool?.description || '',
    input_schema: tool?.parameters || { type: 'object', properties: {} },
  };
}

/**
 * Maps the OpenAI-style tool_choice values used internally onto Anthropic's
 * object dialect ("required" -> {type:"any"}, forced function -> {type:"tool"}).
 * Anthropic has no top-level parallel_tool_calls; `disable_parallel_tool_use`
 * lives inside the tool_choice object, so `parallelToolCalls === false` forces
 * a tool_choice even when the caller did not set one.
 */
function toAnthropicToolChoice(toolChoice, parallelToolCalls) {
  let choice;
  if (toolChoice === 'auto') choice = { type: 'auto' };
  else if (toolChoice === 'none') choice = { type: 'none' };
  else if (toolChoice === 'required') choice = { type: 'any' };
  else if (toolChoice && typeof toolChoice === 'object') {
    choice =
      toolChoice.type === 'function' && toolChoice.function?.name
        ? { type: 'tool', name: toolChoice.function.name }
        : toolChoice;
  }
  if (parallelToolCalls === false) {
    choice = { ...(choice || { type: 'auto' }) };
    if (choice.type !== 'none') choice.disable_parallel_tool_use = true;
  }
  return choice;
}

/**
 * Converts internal message history to Anthropic's format: system messages are
 * hoisted to the top-level `system` field, assistant tool calls become
 * `tool_use` content blocks, and consecutive `tool` messages are grouped into
 * one user message of `tool_result` blocks (Anthropic requires all results for
 * a turn in a single user message, tool_result blocks first). Internal-input
 * only — see file header comment.
 */
function toAnthropicMessages(messages) {
  const systemParts = [];
  const output = [];
  for (const message of messages) {
    const role = message?.role || 'user';
    const text = typeof message?.content === 'string' ? message.content : '';
    if (role === 'system') {
      if (text) systemParts.push(text);
      continue;
    }
    if (role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: String(message?.toolCallId ?? ''),
        content: text,
      };
      const previous = output[output.length - 1];
      if (
        previous?.role === 'user' &&
        Array.isArray(previous.content) &&
        previous.content.every((oneBlock) => oneBlock.type === 'tool_result')
      ) {
        previous.content.push(block);
      } else {
        output.push({ role: 'user', content: [block] });
      }
      continue;
    }
    const toolCalls = message?.toolCalls;
    if (role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
      const blocks = [];
      if (text.trim()) blocks.push({ type: 'text', text });
      toolCalls.forEach((toolCall, index) => {
        const args = toolCall?.arguments;
        blocks.push({
          type: 'tool_use',
          id: toolCall?.id || `tool_${output.length}_${index}`,
          name: toolCall?.name || '',
          input: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
        });
      });
      output.push({ role: 'assistant', content: blocks });
      continue;
    }
    output.push({ role, content: text });
  }
  return { system: systemParts.join('\n\n') || undefined, messages: output };
}

/** Anthropic Messages API client. */
function anthropicClient({ apiKey, model, serviceTier }) {
  return {
    async complete({
      prompt = '',
      messages,
      tools,
      toolChoice,
      parallelToolCalls,
      temperature,
      signal,
      verboseLogs = false,
    }) {
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
      const hasMessages = Array.isArray(messages) && messages.length > 0;
      const translated = hasMessages ? toAnthropicMessages(messages) : null;
      const body = {
        model,
        max_tokens: 4096,
        messages: hasMessages
          ? translated.messages
          : [{ role: 'user', content: anthropicCacheableContent(prompt) }],
      };
      if (translated?.system) body.system = translated.system;
      const hasTools = Array.isArray(tools) && tools.length > 0;
      if (hasTools) body.tools = tools.map(toAnthropicTool);
      // tool_choice without tools is a 400 on the Messages API.
      const anthropicToolChoice = hasTools
        ? toAnthropicToolChoice(toolChoice, parallelToolCalls)
        : undefined;
      if (anthropicToolChoice) body.tool_choice = anthropicToolChoice;
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
      if (!res.ok) {
        const error = new Error(await readErrorText(res));
        error.status = res.status;
        const retryAfterMs = parseRetryAfterMs(res.headers?.get?.('Retry-After'));
        if (Number.isFinite(retryAfterMs)) error.retryAfterMs = retryAfterMs;
        throw error;
      }

      const data = await res.json();
      logClientVerbose(verboseLogs, 'LLM client raw response data:', data);
      logCacheUsage('anthropic', data, verboseLogs);
      const blocks = Array.isArray(data?.content) ? data.content : [];
      const textParts = [];
      const reasoningParts = [];
      const toolCalls = [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          textParts.push(block.text);
        } else if (block?.type === 'thinking' && typeof block.thinking === 'string') {
          reasoningParts.push(block.thinking);
        } else if (block?.type === 'tool_use') {
          // `input` arrives as an already-parsed object, unlike OpenAI's
          // JSON-string `arguments`.
          toolCalls.push({
            id: typeof block.id === 'string' ? block.id : null,
            name: typeof block.name === 'string' ? block.name : '',
            arguments:
              block.input && typeof block.input === 'object' && !Array.isArray(block.input)
                ? block.input
                : {},
          });
        }
      }
      const content = textParts.join('\n').trim();
      if (!content && toolCalls.length === 0) throw new Error('Empty LLM response');
      return {
        content,
        reasoning: reasoningParts.join('\n\n').trim() || undefined,
        toolCalls,
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
 * Creates a completion client for a stored provider entry. Every client
 * accepts the same options — including message history and function tools —
 * and returns tool calls in the normalized `{id, name, arguments}` shape with
 * `arguments` as a parsed object.
 *
 * `messages` and `tools` follow one strict internal contract; the client's
 * converters accept ONLY this shape (see file header comment) — provider
 * wire shapes (OpenAI's `tool_calls`/`tool_call_id`/`{type:'function',
 * function:{...}}` wrappers, string-encoded `arguments`, Anthropic's
 * `input_schema`) are never accepted as input. The sole producer of this
 * shape is src/chat/articleChat.js.
 *   - message: `{ role, content, reasoning?, toolCallId?, toolCalls? }`
 *     where `toolCalls` items are `{ id, name, arguments }` and `arguments`
 *     is always a plain object (never a JSON string).
 *   - tool: `{ name, description, parameters }`.
 *
 * Tolerance for provider quirks (JSON-string arguments, `call_id` vs `id`,
 * missing ids, `<think>` tags, `thinking` content blocks, ...) is applied
 * only when parsing the HTTP response that comes back from the provider —
 * that inbound boundary is where malformed/varying data actually
 * originates, so that is the only place defensive parsing belongs.
 * @param {{type: string, model: string, token?: string, url?: string}} provider
 * @returns {{complete: (opts: {
 *   prompt?: string,
 *   messages?: Array<{role: string, content: string, reasoning?: string, toolCallId?: string, toolCalls?: Array<{id: string, name: string, arguments: Record<string, unknown>}>}>,
 *   tools?: Array<{name: string, description: string, parameters: Record<string, unknown>}>,
 *   toolChoice?: unknown,
 *   parallelToolCalls?: boolean,
 *   temperature?: number,
 *   signal?: AbortSignal,
 *   verboseLogs?: boolean,
 * }) => Promise<{
 *   content: string,
 *   reasoning?: string,
 *   toolCalls?: Array<{id: string | null, name: string, arguments: Record<string, unknown>}>,
 *   endpoint: string,
 *   model: string,
 *   provider: string,
 *   usage?: Record<string, number>,
 * }>}}
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
