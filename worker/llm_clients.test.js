import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createClient, buildChatCompletionsUrl, stripThink } from './llm_clients.js';

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

describe('createClient dispatch', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('throws for unsupported types', () => {
    expect(() => createClient({ type: 'ghost', model: 'm' })).toThrow(/Unsupported/);
    expect(() => createClient(null)).toThrow(/required/);
  });

  it('openai client posts to api.openai.com with bearer token and cache key, no cache_prompt', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({ type: 'openai', model: 'gpt-4o', token: 'sk-1' });
    const out = await client.complete({ prompt: 'p', temperature: 0.3 });
    expect(out.content).toBe('hi');

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

  it('deepseek client posts to api.deepseek.com without OpenAI or llama.cpp cache knobs', async () => {
    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({ type: 'deepseek', model: 'deepseek-v4-flash', token: 'k' });
    await client.complete({ prompt: 'p' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('https://api.deepseek.com/chat/completions');
    expect(init.headers.Authorization).toBe('Bearer k');
    const body = JSON.parse(init.body);
    expect(body.prompt_cache_key).toBeUndefined();
    expect(body.cache_prompt).toBeUndefined();
  });

  it('openai_comp client requires a url and adds cache_prompt', async () => {
    expect(() => createClient({ type: 'openai_comp', model: 'm' })).toThrow(/base URL/);

    vi.mocked(fetch).mockResolvedValue(okJson({ choices: [{ message: { content: 'hi' } }] }));
    const client = createClient({ type: 'openai_comp', model: 'm', url: 'http://host:8989' });
    await client.complete({ prompt: 'p' });
    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('http://host:8989/v1/chat/completions');
    expect(JSON.parse(init.body).cache_prompt).toBe(true);
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
      }),
    );
    const client = createClient({ type: 'anthropic', model: 'claude-haiku-4-5', token: 'sk-ant' });
    const out = await client.complete({ prompt: 'p', temperature: 0.5 });
    expect(out.content).toBe('line1\nline2');

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
});
