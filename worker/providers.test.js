import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ProviderType,
  PROVIDER_TYPES,
  PROVIDER_DEFINITIONS,
  ServiceTier,
  getProviderDefinition,
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
    expect(await mod.getProvidersState()).toEqual({ providers: [], activeId: null });
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
