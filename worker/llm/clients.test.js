import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createClient,
  buildChatCompletionsUrl,
  extractLlmUsage,
  stripThink,
} from './clients.js';

function okJson(json) {
  return { ok: true, status: 200, json: async () => json };
}

describe('buildChatCompletionsUrl', () => {
  it('appends /v1/chat/completions to a bare host', () => {
    expect(buildChatCompletionsUrl('http://host:8989')).toBe(
      'http://host:8989/v1/chat/completions',
    );
  });

  it('appends /chat/completions when base already ends in /vN', () => {
    expect(buildChatCompletionsUrl('https://api.example.com/v1')).toBe(
      'https://api.example.com/v1/chat/completions',
    );
  });

  it('returns a full chat/completions URL unchanged', () => {
    expect(buildChatCompletionsUrl('http://host/v1/chat/completions')).toBe(
      'http://host/v1/chat/completions',
    );
  });

  it('strips trailing slashes and rejects empty', () => {
    expect(buildChatCompletionsUrl('http://host/')).toBe('http://host/v1/chat/completions');
    expect(() => buildChatCompletionsUrl('  ')).toThrow(/required/);
  });
});

describe('stripThink', () => {
  it('removes think blocks and trims', () => {
    expect(stripThink('<think>x</think> hi ')).toBe('hi');
  });
});

describe('extractLlmUsage', () => {
  it('normalizes OpenAI token and prompt-cache usage', () => {
    expect(
      extractLlmUsage('openai', {
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 100,
          total_tokens: 1300,
          prompt_tokens_details: { cached_tokens: 900 },
          completion_tokens_details: { reasoning_tokens: 40 },
        },
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 100,
      totalTokens: 1300,
      reasoningTokens: 40,
      cacheReadTokens: 900,
      cacheMissTokens: 300,
    });
  });

  it('separates OpenRouter cache writes from uncached prompt tokens', () => {
    expect(
      extractLlmUsage('openrouter', {
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 100,
          total_tokens: 1300,
          prompt_tokens_details: { cached_tokens: 900, cache_write_tokens: 100 },
        },
      }),
    ).toEqual({
      inputTokens: 1200,
      outputTokens: 100,
      totalTokens: 1300,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
      cacheMissTokens: 200,
    });
  });

  it('includes Anthropic cache reads and writes in normalized input', () => {
    expect(
      extractLlmUsage('anthropic', {
        usage: {
          input_tokens: 50,
          output_tokens: 15,
          output_tokens_details: { thinking_tokens: 10 },
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 3000,
        },
      }),
    ).toEqual({
      inputTokens: 4050,
      outputTokens: 15,
      reasoningTokens: 10,
      totalTokens: 4065,
      cacheReadTokens: 3000,
      cacheWriteTokens: 1000,
      cacheMissTokens: 50,
    });
  });

  it('uses llama.cpp timing counts when standard usage is absent', () => {
    expect(
      extractLlmUsage('openai-compatible', {
        timings: { cache_n: 80, prompt_n: 20, predicted_n: 12 },
      }),
    ).toEqual({
      inputTokens: 100,
      outputTokens: 12,
      totalTokens: 112,
      cacheReadTokens: 80,
      cacheMissTokens: 20,
    });
  });
});

describe('createClient dispatch', () => {
  let consoleLogSpy;

  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    consoleLogSpy.mockRestore();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws for unsupported types', () => {
    expect(() => createClient({ type: 'ghost', model: 'm' })).toThrow(/Unsupported/);
    expect(() => createClient(null)).toThrow(/required/);
  });

  it('skips raw request/response dumps unless verboseLogs is enabled', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [{ message: { content: 'hi' } }],
        usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
      }),
    );
    const client = createClient({ type: 'openai', model: 'gpt-4o', token: 'sk-1' });

    await client.complete({ prompt: 'quiet' });
    expect(consoleLogSpy).not.toHaveBeenCalled();

    await client.complete({ prompt: 'loud', verboseLogs: true });
    expect(consoleLogSpy).toHaveBeenCalledWith('LLM client raw prompt:', 'loud');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'LLM client request:',
      expect.objectContaining({ endpoint: 'https://api.openai.com/v1/chat/completions' }),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'LLM client raw response data:',
      expect.objectContaining({ choices: expect.any(Array) }),
    );
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'LLM cache usage:',
      expect.objectContaining({ provider: 'openai' }),
    );
  });

  it('refuses token transport to invalid provider URLs', async () => {
    const client = createClient({
      type: 'openai_comp',
      model: 'm',
      token: 'sk-1',
      url: 'not-a-valid-url',
    });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(/valid URL/);
  });

  it('refuses token transport to non-HTTPS remote endpoints', async () => {
    const client = createClient({
      type: 'openai_comp',
      model: 'm',
      token: 'sk-1',
      url: 'http://remote.example.com/v1',
    });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(/non-HTTPS/);
  });

  it('openai client posts to api.openai.com with bearer token and cache key, no cache_prompt', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [{ message: { content: 'hi' } }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 12,
          total_tokens: 1212,
          prompt_tokens_details: { cached_tokens: 900 },
        },
      }),
    );
    const client = createClient({ type: 'openai', model: 'gpt-4o', token: 'sk-1' });
    const out = await client.complete({ prompt: 'p', temperature: 0.3, verboseLogs: true });
    expect(out.content).toBe('hi');
    expect(consoleLogSpy).toHaveBeenCalledWith('LLM cache usage:', {
      provider: 'openai',
      cache_hit_tokens: 900,
      cache_miss_tokens: 300,
      cache_hit_rate_percent: 75,
      prompt_tokens: 1200,
      cache_creation_tokens: undefined,
      raw_usage: {
        prompt_tokens: 1200,
        completion_tokens: 12,
        total_tokens: 1212,
        prompt_tokens_details: { cached_tokens: 900 },
      },
      llama_timings: undefined,
    });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer sk-1');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'p' }],
      temperature: 0.3,
      prompt_cache_key: 'pagetollm-canvas',
    });
    expect(body.cache_prompt).toBeUndefined();
  });

  it('openai client omits temperature for gpt-5-mini / gpt-5-nano', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({ type: 'openai', model: 'gpt-5-nano', token: 'k' });
    await client.complete({ prompt: 'p', temperature: 0.7 });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body).toEqual({
      model: 'gpt-5-nano',
      messages: [{ role: 'user', content: 'p' }],
      prompt_cache_key: 'pagetollm-canvas',
    });
    expect('temperature' in body).toBe(false);
  });

  it('openai client forwards configured flex service tier', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({
      type: 'openai',
      model: 'gpt-4o',
      token: 'k',
      serviceTier: 'flex',
    });
    await client.complete({ prompt: 'p' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.service_tier).toBe('flex');
  });

  it('openai_comp client keeps temperature even for gpt-5-nano-named models', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({ type: 'openai_comp', model: 'gpt-5-nano', url: 'http://h' });
    await client.complete({ prompt: 'p', temperature: 0.2 });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.temperature).toBe(0.2);
  });

  it('openrouter client posts to openrouter.ai', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({ type: 'openrouter', model: 'openai/gpt-4o-mini', token: 'k' });
    await client.complete({ prompt: 'p' });
    expect(vi.mocked(fetch).mock.calls[0][0]).toBe('https://openrouter.ai/api/v1/chat/completions');
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.cache_prompt).toBeUndefined();
  });

  it('openrouter client forwards configured service tier', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({
      type: 'openrouter',
      model: 'openai/gpt-5',
      token: 'k',
      serviceTier: 'priority',
    });
    await client.complete({ prompt: 'p' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.service_tier).toBe('priority');
  });

  it('deepseek client posts to api.deepseek.com without OpenAI or llama.cpp cache knobs', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [{ message: { content: 'hi' } }],
        usage: {
          prompt_tokens: 1000,
          completion_tokens: 10,
          total_tokens: 1010,
          prompt_cache_hit_tokens: 640,
          prompt_cache_miss_tokens: 360,
        },
      }),
    );
    const client = createClient({ type: 'deepseek', model: 'deepseek-v4-flash', token: 'k' });
    await client.complete({ prompt: 'p', verboseLogs: true });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'LLM cache usage:',
      expect.objectContaining({
        provider: 'deepseek',
        cache_hit_tokens: 640,
        cache_miss_tokens: 360,
        cache_hit_rate_percent: 64,
      }),
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.cache_prompt).toBeUndefined();
  });

  it('openai_comp client requires a url and adds cache_prompt', async () => {
    expect(() => createClient({ type: 'openai_comp', model: 'm' })).toThrow(/base URL/);

    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [{ message: { content: 'hi' } }],
        usage: {
          completion_tokens: 20,
          prompt_tokens: 80,
          total_tokens: 100,
          prompt_tokens_details: { cached_tokens: 50 },
        },
        timings: {
          cache_n: 50,
          prompt_n: 30,
          prompt_ms: 12,
          predicted_n: 20,
          predicted_ms: 35,
        },
      }),
    );
    const client = createClient({ type: 'openai_comp', model: 'm', url: 'http://host:8989' });
    await client.complete({ prompt: 'p', verboseLogs: true });
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'LLM cache usage:',
      expect.objectContaining({
        provider: 'openai-compatible',
        cache_hit_tokens: 50,
        cache_miss_tokens: 30,
        cache_hit_rate_percent: 62.5,
        llama_timings: expect.objectContaining({ cache_n: 50, prompt_n: 30 }),
      }),
    );
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://host:8989/v1/chat/completions');
    expect(JSON.parse(init.body).cache_prompt).toBe(true);
  });

  it('openai_comp sends message history and tools and parses tool-only responses', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [
          {
            message: {
              content: null,
              reasoning_content: 'I found the evidence.',
              tool_calls: [
                {
                  id: 'call-1',
                  type: 'function',
                  function: {
                    name: 'highlight_span',
                    arguments: '{"start_line":2,"end_line":3}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const client = createClient({ type: 'openai_comp', model: 'm', url: 'http://localhost:8989' });
    const result = await client.complete({
      messages: [
        { role: 'system', content: 'system' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'prior', name: 'highlight_span', arguments: { start_line: 1, end_line: 1 } },
          ],
        },
        { role: 'tool', content: 'Highlighted lines 1-1.', toolCallId: 'prior' },
      ],
      tools: [
        {
          name: 'highlight_span',
          description: 'Highlight evidence',
          parameters: { type: 'object', properties: {} },
        },
      ],
      toolChoice: 'auto',
      parallelToolCalls: true,
    });

    expect(result).toMatchObject({
      content: '',
      reasoning: 'I found the evidence.',
      toolCalls: [
        {
          id: 'call-1',
          name: 'highlight_span',
          arguments: { start_line: 2, end_line: 3 },
        },
      ],
    });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.messages[1].tool_calls[0].function.arguments).toBe('{"start_line":1,"end_line":1}');
    expect(body.messages[2].tool_call_id).toBe('prior');
    expect(body.tools[0].function.name).toBe('highlight_span');
    expect(body.tool_choice).toBe('auto');
    expect(body.parallel_tool_calls).toBe(true);
  });

  it('openai client forwards tools and tool_choice and parses tool calls', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: 'call-9',
                  type: 'function',
                  function: { name: 'highlight_span', arguments: '{"start_line":4,"end_line":5}' },
                },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    );
    const client = createClient({ type: 'openai', model: 'gpt-4o', token: 'k' });
    const result = await client.complete({
      messages: [{ role: 'user', content: 'q' }],
      tools: [
        {
          name: 'highlight_span',
          description: 'Highlight evidence',
          parameters: { type: 'object', properties: {} },
        },
      ],
      toolChoice: 'required',
      parallelToolCalls: false,
    });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'highlight_span',
          description: 'Highlight evidence',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(body.tool_choice).toBe('required');
    expect(body.parallel_tool_calls).toBe(false);
    expect(result.toolCalls).toEqual([
      { id: 'call-9', name: 'highlight_span', arguments: { start_line: 4, end_line: 5 } },
    ]);
  });

  it('openai-compatible client tolerates call_id and missing ids in inbound tool_calls', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  call_id: 'call-legacy',
                  type: 'function',
                  function: { name: 'highlight_span', arguments: '{"start_line":1,"end_line":2}' },
                },
                {
                  type: 'function',
                  function: { name: 'highlight_span', arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const client = createClient({ type: 'openai', model: 'gpt-4o', token: 'k' });
    const result = await client.complete({ prompt: 'p' });
    expect(result.toolCalls).toEqual([
      { id: 'call-legacy', name: 'highlight_span', arguments: { start_line: 1, end_line: 2 } },
      { id: null, name: 'highlight_span', arguments: {} },
    ]);
  });

  it('openai-compatible client combines <think> tags and reasoning_content into reasoning', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        choices: [
          {
            message: {
              content: '<think>pondering</think>final answer',
              reasoning_content: 'also considered this',
            },
          },
        ],
      }),
    );
    const client = createClient({ type: 'openai', model: 'gpt-4o', token: 'k' });
    const result = await client.complete({ prompt: 'p' });
    expect(result.content).toBe('final answer');
    expect(result.reasoning).toBe('also considered this\n\npondering');
  });

  it('omits tool_choice and parallel_tool_calls when no tools are sent', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({ type: 'openrouter', model: 'openai/gpt-4o-mini', token: 'k' });
    await client.complete({ prompt: 'p', toolChoice: 'auto', parallelToolCalls: true });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
    expect(body.parallel_tool_calls).toBeUndefined();
  });

  it('refuses to send bearer tokens to non-HTTPS non-local custom URLs', async () => {
    const client = createClient({
      type: 'openai_comp',
      model: 'm',
      token: 'secret',
      url: 'http://host:8989',
    });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow(/non-HTTPS/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows bearer tokens to localhost custom URLs', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({
      type: 'openai_comp',
      model: 'm',
      token: 'secret',
      url: 'http://localhost:8989',
    });
    await client.complete({ prompt: 'p' });
    expect(vi.mocked(fetch).mock.calls[0][1].headers.Authorization).toBe('Bearer secret');
  });

  it('openai-compatible client throws on non-ok and empty content', async () => {
    const client = createClient({ type: 'openai', model: 'm', token: 'k' });

    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 503, text: async () => 'down' });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow('LLM HTTP 503: down');

    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: '  ' } }] }));
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow('Empty LLM response');
  });

  it('anthropic client posts to the messages API and joins text blocks', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        content: [
          { type: 'text', text: 'line1' },
          { type: 'thinking', thinking: 'ignored' },
          { type: 'text', text: 'line2' },
        ],
        usage: {
          input_tokens: 50,
          output_tokens: 15,
          cache_creation_input_tokens: 1000,
          cache_read_input_tokens: 3000,
        },
      }),
    );
    const client = createClient({ type: 'anthropic', model: 'claude-haiku-4-5', token: 'sk-ant' });
    const out = await client.complete({ prompt: 'p', temperature: 0.5, verboseLogs: true });
    expect(out.content).toBe('line1\nline2');
    expect(consoleLogSpy).toHaveBeenCalledWith(
      'LLM cache usage:',
      expect.objectContaining({
        provider: 'anthropic',
        cache_hit_tokens: 3000,
        cache_miss_tokens: 50,
        cache_creation_tokens: 1000,
      }),
    );

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-ant');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(init.body);
    expect(body.max_tokens).toBe(4096);
    // No top-level cache_control: with no marker there is no stable prefix to
    // cache, so we must not auto-cache the (volatile) whole prompt.
    expect(body.cache_control).toBeUndefined();
    expect(body.temperature).toBe(0.5);
    expect(body.messages).toEqual([{ role: 'user', content: 'p' }]);
  });

  it('anthropic client maps supported service tiers to native request values', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ content: [{ type: 'text', text: 'ok' }] }));
    const priorityClient = createClient({
      type: 'anthropic',
      model: 'claude-haiku-4-5',
      token: 'k',
      serviceTier: 'priority',
    });
    await priorityClient.complete({ prompt: 'p' });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[0][1].body).service_tier).toBe('auto');

    const standardClient = createClient({
      type: 'anthropic',
      model: 'claude-haiku-4-5',
      token: 'k',
      serviceTier: 'default',
    });
    await standardClient.complete({ prompt: 'p' });
    expect(JSON.parse(vi.mocked(fetch).mock.calls[1][1].body).service_tier).toBe('standard_only');
  });

  it('anthropic client marks stable prompt prefixes as explicit cache breakpoints', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ content: [{ type: 'text', text: 'ok' }] }));
    const client = createClient({ type: 'anthropic', model: 'claude-haiku-4-5', token: 'k' });
    await client.complete({ prompt: 'Static rules\n<text>Dynamic article text</text>' });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.messages).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'Static rules\n<text>',
            cache_control: { type: 'ephemeral' },
          },
          { type: 'text', text: 'Dynamic article text</text>' },
        ],
      },
    ]);
    // The dynamic suffix must not carry a breakpoint, and there must be no
    // top-level auto-cache that would re-add one on the last (volatile) block.
    expect(body.messages[0].content[1].cache_control).toBeUndefined();
    expect(body.cache_control).toBeUndefined();
  });

  it('anthropic client throws when no text blocks are returned', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ content: [] }));
    const client = createClient({ type: 'anthropic', model: 'claude-haiku-4-5', token: 'k' });
    await expect(client.complete({ prompt: 'p' })).rejects.toThrow('Empty LLM response');
  });

  it('anthropic client translates history, tools and tool_choice to the Messages API format', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ content: [{ type: 'text', text: 'done' }] }));
    const client = createClient({ type: 'anthropic', model: 'claude-haiku-4-5', token: 'k' });
    await client.complete({
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: 'q' },
        {
          role: 'assistant',
          content: 'checking',
          toolCalls: [
            { id: 'toolu_1', name: 'highlight_span', arguments: { start_line: 1, end_line: 2 } },
            { id: 'toolu_2', name: 'highlight_span', arguments: { start_line: 5, end_line: 5 } },
          ],
        },
        { role: 'tool', content: 'Highlighted lines 1-2.', toolCallId: 'toolu_1' },
        { role: 'tool', content: 'Highlighted lines 5-5.', toolCallId: 'toolu_2' },
      ],
      tools: [
        {
          name: 'highlight_span',
          description: 'Highlight evidence',
          parameters: { type: 'object', properties: {} },
        },
      ],
      toolChoice: 'required',
      parallelToolCalls: false,
    });

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.system).toBe('be brief');
    expect(body.tools).toEqual([
      {
        name: 'highlight_span',
        description: 'Highlight evidence',
        input_schema: { type: 'object', properties: {} },
      },
    ]);
    expect(body.tool_choice).toEqual({ type: 'any', disable_parallel_tool_use: true });
    expect(body.messages).toEqual([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'checking' },
          {
            type: 'tool_use',
            id: 'toolu_1',
            name: 'highlight_span',
            input: { start_line: 1, end_line: 2 },
          },
          {
            type: 'tool_use',
            id: 'toolu_2',
            name: 'highlight_span',
            input: { start_line: 5, end_line: 5 },
          },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'Highlighted lines 1-2.' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'Highlighted lines 5-5.' },
        ],
      },
    ]);
  });

  it('anthropic client parses tool_use blocks and accepts tool-only responses', async () => {
    vi.mocked(fetch).mockResolvedValue(
      okJson({
        stop_reason: 'tool_use',
        content: [
          { type: 'thinking', thinking: 'find the span' },
          {
            type: 'tool_use',
            id: 'toolu_9',
            name: 'highlight_span',
            input: { start_line: 3, end_line: 4 },
          },
        ],
      }),
    );
    const client = createClient({ type: 'anthropic', model: 'claude-haiku-4-5', token: 'k' });
    const result = await client.complete({
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'highlight_span', description: '', parameters: { type: 'object' } }],
    });
    expect(result.content).toBe('');
    expect(result.reasoning).toBe('find the span');
    expect(result.toolCalls).toEqual([
      { id: 'toolu_9', name: 'highlight_span', arguments: { start_line: 3, end_line: 4 } },
    ]);
  });

  it('anthropic client omits tool_choice when no tools are configured', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ content: [{ type: 'text', text: 'ok' }] }));
    const client = createClient({ type: 'anthropic', model: 'claude-haiku-4-5', token: 'k' });
    await client.complete({ prompt: 'p', toolChoice: 'required', parallelToolCalls: false });
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1].body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
