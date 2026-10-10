import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProviderType,
  PROVIDER_TYPES,
  PROVIDER_DEFINITIONS,
  ServiceTier,
  getProviderDefinition,
  isCompletionProvider,
  isDecisionProvider,
  normalizeProvider,
  sanitizeProvider,
  PROVIDERS_KEY,
} from './providers.js';

/** In-memory chrome.storage.local stub. */
function installFakeStorage(initial = {}) {
  const store = { ...initial };
  vi.stubGlobal('chrome', {
    runtime: { lastError: undefined },
    storage: {
      local: {
        get: (keys, cb) => {
          const key = Array.isArray(keys) ? keys[0] : keys;
          cb({ [key]: store[key] });
        },
        set: (items, cb) => {
          Object.assign(store, items);
          cb();
        },
      },
    },
  });
  return store;
}

async function freshProviders() {
  vi.resetModules();
  return import('./providers.js');
}

describe('provider definitions', () => {
  it('exposes a definition for every provider type', () => {
    for (const type of PROVIDER_TYPES) {
      expect(getProviderDefinition(type)).toBeTruthy();
    }
    expect(getProviderDefinition('nope')).toBeNull();
  });

  it('marks openai_comp as requiring a URL', () => {
    const def = getProviderDefinition(ProviderType.OPENAI_COMP);
    expect(def.requiresUrl).toBe(true);
    expect(PROVIDER_DEFINITIONS.find((d) => d.type === ProviderType.OPENAI).requiresUrl).toBe(
      false,
    );
  });
});

describe('normalizeProvider', () => {
  it('rejects unknown types', () => {
    expect(() => normalizeProvider({ type: 'bogus', name: 'x', model: 'm' })).toThrow(
      /Provider type/,
    );
  });

  it('rejects non-object input', () => {
    expect(() => normalizeProvider(null)).toThrow(/object/);
  });

  it('requires name and model', () => {
    expect(() => normalizeProvider({ type: 'openai', model: 'm' })).toThrow(/name/);
    expect(() => normalizeProvider({ type: 'openai', name: 'n' })).toThrow(/model/);
  });

  it('keeps per-task temperatures and drops the empty ones', () => {
    const entry = normalizeProvider({
      type: 'openai',
      name: 'n',
      model: 'm',
      temperatures: { summaries: '0.8', chat: 0, splitting: '' },
    });
    expect(entry.temperatures).toEqual({ summaries: 0.8, chat: 0 });
  });

  it('leaves temperatures unset when no field is filled in', () => {
    const entry = normalizeProvider({
      type: 'openai',
      name: 'n',
      model: 'm',
      temperatures: { summaries: '', chat: '', splitting: '' },
    });
    expect(entry.temperatures).toBeUndefined();
  });

  it('rejects an out-of-range temperature', () => {
    expect(() =>
      normalizeProvider({ type: 'openai', name: 'n', model: 'm', temperatures: { chat: '3' } }),
    ).toThrow(/Temperature \(chat\)/);
  });

  it('requires a url for openai_comp', () => {
    expect(() => normalizeProvider({ type: 'openai_comp', name: 'n', model: 'm' })).toThrow(/URL/);
  });

  it('generates an id when none is supplied and trims fields', () => {
    const entry = normalizeProvider({
      type: 'openai',
      name: '  OpenAI  ',
      model: '  gpt-4o ',
      token: ' sk-1 ',
    });
    expect(entry.id).toBeTruthy();
    expect(entry.name).toBe('OpenAI');
    expect(entry.model).toBe('gpt-4o');
    expect(entry.token).toBe('sk-1');
    expect(entry.url).toBeUndefined();
  });

  it('preserves a supplied id', () => {
    const entry = normalizeProvider({ id: 'fixed', type: 'openai', name: 'n', model: 'm' });
    expect(entry.id).toBe('fixed');
  });

  it('normalizes an optional context window and rejects invalid bounds', () => {
    expect(
      normalizeProvider({
        type: 'openai_comp',
        name: 'local',
        model: 'm',
        url: 'http://localhost:8989',
        contextWindowTokens: '8192',
      }).contextWindowTokens,
    ).toBe(8192);
    expect(
      normalizeProvider({ type: 'openai', name: 'n', model: 'm', contextWindowTokens: '' })
        .contextWindowTokens,
    ).toBeUndefined();
    expect(
      normalizeProvider({ type: 'openai', name: 'n', model: 'm', contextWindowTokens: 4096 })
        .contextWindowTokens,
    ).toBe(4096);
    expect(() =>
      normalizeProvider({ type: 'openai', name: 'n', model: 'm', contextWindowTokens: 1024 }),
    ).toThrow(/Context window/);
  });

  it('normalizes supported service tiers and rejects unsupported provider combinations', () => {
    expect(
      normalizeProvider({
        type: 'openai',
        name: 'n',
        model: 'm',
        serviceTier: ServiceTier.FLEX,
      }).serviceTier,
    ).toBe(ServiceTier.FLEX);
    expect(
      normalizeProvider({
        type: 'anthropic',
        name: 'n',
        model: 'claude-haiku-4-5',
        serviceTier: ServiceTier.PRIORITY,
      }).serviceTier,
    ).toBe(ServiceTier.PRIORITY);
    expect(() =>
      normalizeProvider({
        type: 'anthropic',
        name: 'n',
        model: 'claude-haiku-4-5',
        serviceTier: ServiceTier.FLEX,
      }),
    ).toThrow(/Service tier/);
    expect(() =>
      normalizeProvider({
        type: 'openai_comp',
        name: 'n',
        model: 'm',
        url: 'http://localhost:8989',
        serviceTier: ServiceTier.FLEX,
      }),
    ).toThrow(/Service tier/);
  });

  it('sanitizes tokens for UI responses', () => {
    const safe = sanitizeProvider({
      id: 'p',
      type: 'openai',
      name: 'OpenAI',
      model: 'm',
      token: 'sk-1',
    });
    expect(safe.token).toBeUndefined();
    expect(safe.hasToken).toBe(true);
  });
});

describe('provider storage', () => {
  beforeEach(() => {
    installFakeStorage();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns empty state when nothing stored', async () => {
    const mod = await freshProviders();
    expect(await mod.getProvidersState()).toEqual({
      providers: [],
      activeId: null,
      splitterId: null,
    });
    expect(await mod.getActiveProvider()).toBeNull();
  });

  it('saves a provider and makes the first one active', async () => {
    const mod = await freshProviders();
    const saved = await mod.saveProvider({
      type: 'openai',
      name: 'A',
      model: 'gpt-4o',
      token: 'k',
    });
    const state = await mod.getProvidersState();
    expect(state.providers).toHaveLength(1);
    expect(state.activeId).toBe(saved.id);
    expect((await mod.getActiveProvider()).name).toBe('A');
  });

  it('uses a decision provider only once selected as topic splitter', async () => {
    const mod = await freshProviders();
    expect(await mod.getDecisionProvider()).toBeNull();
    const completion = await mod.saveProvider({
      type: 'openai',
      name: 'A',
      model: 'gpt-4o',
      token: 'k',
    });
    const decision = await mod.saveProvider({
      type: 'llama_decision',
      name: 'Decisions',
      url: 'http://localhost:8080',
    });
    expect(await mod.getDecisionProvider()).toBeNull();
    expect((await mod.setTopicSplitter(decision.id)).splitterId).toBe(decision.id);
    expect((await mod.getDecisionProvider()).id).toBe(decision.id);
    expect(mod.sanitizeProvidersState(await mod.getProvidersState()).splitterId).toBe(decision.id);
    expect((await mod.getActiveProvider()).name).toBe('A');

    await expect(mod.setTopicSplitter(completion.id)).rejects.toThrow(/Only decision/);
    await expect(mod.setTopicSplitter('nope')).rejects.toThrow(/Unknown provider/);
    expect((await mod.setTopicSplitter(null)).splitterId).toBeNull();
    expect(await mod.getDecisionProvider()).toBeNull();
  });

  it('clears the topic splitter when its provider is deleted', async () => {
    const mod = await freshProviders();
    const decision = await mod.saveProvider({
      type: 'llama_decision',
      name: 'Decisions',
      url: 'http://localhost:8080',
    });
    await mod.setTopicSplitter(decision.id);
    expect((await mod.deleteProvider(decision.id)).splitterId).toBeNull();
    expect(await mod.getDecisionProvider()).toBeNull();
  });

  it('ignores a stored splitter id that is not a decision provider', async () => {
    installFakeStorage({
      [PROVIDERS_KEY]: {
        providers: [{ id: 'completion', type: 'openai', name: 'A', model: 'gpt-4o' }],
        activeId: 'completion',
        splitterId: 'completion',
      },
    });
    const mod = await freshProviders();
    expect(await mod.getDecisionProvider()).toBeNull();
  });

  it('does not activate a decision provider and activates the first completion provider', async () => {
    const mod = await freshProviders();
    const decision = await mod.saveProvider({
      type: 'llama_decision',
      name: 'Decisions',
      url: 'http://localhost:8080',
    });
    expect((await mod.getProvidersState()).activeId).toBeNull();

    const completion = await mod.saveProvider({ type: 'openai', name: 'A', model: 'gpt-4o' });
    expect((await mod.getProvidersState()).activeId).toBe(completion.id);
    await expect(mod.setActiveProvider(decision.id)).rejects.toThrow(/Decision providers/);
    expect((await mod.getProvidersState()).activeId).toBe(completion.id);
  });

  it('serializes concurrent provider mutations without losing updates', async () => {
    const mod = await freshProviders();
    const first = await mod.saveProvider({
      id: 'first',
      type: 'openai',
      name: 'First',
      model: 'gpt-4o',
    });
    const second = await mod.saveProvider({
      id: 'second',
      type: 'anthropic',
      name: 'Second',
      model: 'claude-haiku-4-5',
    });

    await Promise.all([
      mod.deleteProvider(first.id),
      mod.setActiveProvider(second.id),
      mod.saveProvider({
        id: 'third',
        type: 'openai',
        name: 'Third',
        model: 'gpt-4o',
      }),
    ]);

    expect(await mod.getProvidersState()).toEqual({
      providers: [
        expect.objectContaining({ id: 'second' }),
        expect.objectContaining({ id: 'third' }),
      ],
      activeId: second.id,
      splitterId: null,
    });
  });

  it('updates an existing provider without changing active', async () => {
    const mod = await freshProviders();
    const a = await mod.saveProvider({ type: 'openai', name: 'A', model: 'gpt-4o', token: 'k1' });
    await mod.saveProvider({ type: 'anthropic', name: 'B', model: 'claude-haiku-4-5' });
    await mod.saveProvider({ id: a.id, type: 'openai', name: 'A2', model: 'gpt-4o' });
    const state = await mod.getProvidersState();
    expect(state.providers).toHaveLength(2);
    const updated = state.providers.find((p) => p.id === a.id);
    expect(updated.name).toBe('A2');
    expect(updated.token).toBe('k1');
    expect(state.activeId).toBe(a.id);
  });

  it('does not carry a token across provider type changes unless a new token is supplied', async () => {
    const mod = await freshProviders();
    const a = await mod.saveProvider({ type: 'openai', name: 'A', model: 'gpt-4o', token: 'k1' });
    await mod.saveProvider({
      id: a.id,
      type: 'openai_comp',
      name: 'Local',
      model: 'm',
      url: 'http://localhost:8989',
    });
    const updated = (await mod.getProvidersState()).providers[0];
    expect(updated.token).toBe('');
  });

  it('does not carry an openai_comp token when the base URL changes', async () => {
    const mod = await freshProviders();
    const a = await mod.saveProvider({
      type: 'openai_comp',
      name: 'Local',
      model: 'm',
      token: 'k1',
      url: 'http://localhost:8989',
    });
    await mod.saveProvider({
      id: a.id,
      type: 'openai_comp',
      name: 'Local',
      model: 'm',
      url: 'http://localhost:8990',
    });
    const updated = (await mod.getProvidersState()).providers[0];
    expect(updated.token).toBe('');
  });

  it('setActiveProvider switches the active id and rejects unknown ids', async () => {
    const mod = await freshProviders();
    const a = await mod.saveProvider({ type: 'openai', name: 'A', model: 'm' });
    const b = await mod.saveProvider({ type: 'anthropic', name: 'B', model: 'claude-haiku-4-5' });
    await mod.setActiveProvider(b.id);
    expect((await mod.getProvidersState()).activeId).toBe(b.id);
    await expect(mod.setActiveProvider('nope')).rejects.toThrow(/Unknown provider/);
    // a still exists
    expect((await mod.getProvidersState()).providers.find((p) => p.id === a.id)).toBeTruthy();
  });

  it('deleting the active provider falls back to the first remaining', async () => {
    const mod = await freshProviders();
    const a = await mod.saveProvider({ type: 'openai', name: 'A', model: 'm' });
    const b = await mod.saveProvider({ type: 'anthropic', name: 'B', model: 'claude-haiku-4-5' });
    await mod.setActiveProvider(b.id);
    const state = await mod.deleteProvider(b.id);
    expect(state.providers).toHaveLength(1);
    expect(state.activeId).toBe(a.id);
  });

  it('deleting the active completion provider skips decision providers when falling back', async () => {
    const mod = await freshProviders();
    const first = await mod.saveProvider({ type: 'openai', name: 'A', model: 'm' });
    const active = await mod.saveProvider({
      type: 'anthropic',
      name: 'B',
      model: 'claude-haiku-4-5',
    });
    const decision = await mod.saveProvider({
      type: 'llama_decision',
      name: 'Decisions',
      url: 'http://localhost:8080',
    });
    await mod.setActiveProvider(active.id);

    const state = await mod.deleteProvider(active.id);
    expect(state.providers.map((provider) => provider.id)).toEqual([first.id, decision.id]);
    expect(state.activeId).toBe(first.id);
  });

  it('repairs a legacy stored decision active id to a completion provider', async () => {
    installFakeStorage({
      [PROVIDERS_KEY]: {
        providers: [
          { id: 'decision', type: 'llama_decision', name: 'Decisions', url: 'http://localhost' },
          { id: 'completion', type: 'openai', name: 'A', model: 'gpt-4o' },
        ],
        activeId: 'decision',
      },
    });
    const mod = await freshProviders();

    expect((await mod.getProvidersState()).activeId).toBe('completion');
    expect((await mod.getActiveProvider()).id).toBe('completion');
  });

  it('deleting the last provider clears the active id', async () => {
    const mod = await freshProviders();
    const a = await mod.saveProvider({ type: 'openai', name: 'A', model: 'm' });
    const state = await mod.deleteProvider(a.id);
    expect(state.providers).toHaveLength(0);
    expect(state.activeId).toBeNull();
  });

  it('listProviders returns the stored provider list', async () => {
    const mod = await freshProviders();
    await mod.saveProvider({ type: 'openai', name: 'A', model: 'gpt-4o' });
    const providers = await mod.listProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0].name).toBe('A');
  });

  it('rejects storage read failures from chrome.runtime.lastError', async () => {
    vi.stubGlobal('chrome', {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get: (_keys, cb) => {
            chrome.runtime.lastError = { message: 'read failed' };
            cb({});
          },
          set: (_items, cb) => cb(),
        },
      },
    });
    const mod = await freshProviders();
    await expect(mod.getProvidersState()).rejects.toThrow('read failed');
  });

  it('rejects storage write failures from chrome.runtime.lastError', async () => {
    vi.stubGlobal('chrome', {
      runtime: { lastError: undefined },
      storage: {
        local: {
          get: (keys, cb) => {
            const key = Array.isArray(keys) ? keys[0] : keys;
            cb({ [key]: undefined });
          },
          set: (_items, cb) => {
            chrome.runtime.lastError = { message: 'write failed' };
            cb();
          },
        },
      },
    });
    const mod = await freshProviders();
    await expect(mod.saveProvider({ type: 'openai', name: 'A', model: 'gpt-4o' })).rejects.toThrow(
      'write failed',
    );
  });

  it('generates ids without crypto.randomUUID', async () => {
    const originalCrypto = globalThis.crypto;
    vi.stubGlobal('crypto', undefined);
    const mod = await freshProviders();
    const saved = await mod.saveProvider({ type: 'openai', name: 'A', model: 'gpt-4o' });
    expect(saved.id).toMatch(/^prov_/);
    vi.stubGlobal('crypto', originalCrypto);
  });

  it('drops corrupt stored entries and dangling active ids', async () => {
    installFakeStorage({
      [PROVIDERS_KEY]: {
        providers: [{ id: 'ok', type: 'openai' }, { id: 'bad', type: 'mystery' }, null],
        activeId: 'gone',
      },
    });
    const mod = await freshProviders();
    const state = await mod.getProvidersState();
    expect(state.providers.map((p) => p.id)).toEqual(['ok']);
    expect(state.activeId).toBeNull();
  });
});

describe('decision providers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts a server URL and an optional model, without sampling settings', () => {
    const entry = normalizeProvider({
      type: ProviderType.LLAMA_DECISION,
      name: 'Decisions',
      url: 'http://localhost:8080',
      temperatures: { chat: '0.8' },
    });
    expect(entry.model).toBe('');
    expect(entry.temperatures).toBeUndefined();
    expect(getProviderDefinition(entry.type).requiresUrl).toBe(true);
  });

  it.each(['', 'not a url', 'ftp://server', 'http://server?key=secret', 'http://server#fragment'])(
    'rejects invalid server URL %s',
    (url) => {
      expect(() =>
        normalizeProvider({ type: ProviderType.LLAMA_DECISION, name: 'Decisions', url }),
      ).toThrow();
    },
  );

  it('requires HTTPS to send a token to a non-localhost server', () => {
    const base = { type: ProviderType.LLAMA_DECISION, name: 'Decisions', token: 'secret' };
    expect(() => normalizeProvider({ ...base, url: 'http://remote.example' })).toThrow(
      /requires an HTTPS/,
    );
    expect(normalizeProvider({ ...base, url: 'https://remote.example' }).token).toBe('secret');
    expect(normalizeProvider({ ...base, url: 'http://localhost:8080' }).token).toBe('secret');
    expect(normalizeProvider({ ...base, url: 'http://remote.example', token: '' }).token).toBe('');
  });

  it('reads model and temperature rules from the capability field', () => {
    for (const definition of PROVIDER_DEFINITIONS) {
      expect(['completion', 'decision']).toContain(definition.capability);
    }
    expect(isCompletionProvider({ type: ProviderType.LLAMA_DECISION })).toBe(false);
    expect(isDecisionProvider({ type: ProviderType.LLAMA_DECISION })).toBe(true);
    expect(isCompletionProvider({ type: ProviderType.OPENAI_COMP })).toBe(true);
  });

  it('preserves a token for the same server and clears it when the server changes', async () => {
    installFakeStorage();
    const mod = await freshProviders();
    const saved = await mod.saveProvider({
      type: 'llama_decision',
      name: 'Decisions',
      url: 'http://localhost:8080',
      token: 'secret',
    });
    const same = await mod.saveProvider({ ...saved, token: '' });
    expect(same.token).toBe('secret');
    const changed = await mod.saveProvider({ ...saved, url: 'http://localhost:8081', token: '' });
    expect(changed.token).toBe('');
    expect((await mod.getProvidersState()).providers[0].type).toBe('llama_decision');
  });
});
