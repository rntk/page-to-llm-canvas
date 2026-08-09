// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import {
  THEME_LIGHT,
  THEME_DARK,
  THEME_SYSTEM,
  THEME_KEY,
  systemThemeSupported,
  normalizeTheme,
  themeCycle,
  nextTheme,
  themeLabel,
  themeIcon,
  applyTheme,
  applyThemeToElement,
  getStoredTheme,
  setStoredTheme,
  createThemeController,
} from './theme.js';

function makeDoc() {
  const attrs = {};
  return {
    documentElement: {
      setAttribute: (name, value) => {
        attrs[name] = value;
      },
      removeAttribute: (name) => {
        delete attrs[name];
      },
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
    },
  };
}

function winWithDark(matches) {
  return {
    matchMedia: (query) => ({ media: query, matches }),
  };
}

describe('theme key', () => {
  it('stays outside the pagetollm: record prefix', () => {
    expect(THEME_KEY.startsWith('pagetollm:')).toBe(false);
  });
});

describe('systemThemeSupported', () => {
  it('detects support when the media query is recognized', () => {
    expect(systemThemeSupported(winWithDark(true))).toBe(true);
  });

  it('returns false without matchMedia', () => {
    expect(systemThemeSupported({})).toBe(false);
    expect(systemThemeSupported(null)).toBe(false);
  });

  it('returns false when the query is not recognized', () => {
    expect(systemThemeSupported({ matchMedia: () => ({ media: 'not all' }) })).toBe(false);
  });

  it('returns false when matchMedia throws', () => {
    expect(
      systemThemeSupported({
        matchMedia: () => {
          throw new Error('boom');
        },
      }),
    ).toBe(false);
  });
});

describe('normalizeTheme', () => {
  it('passes through explicit light/dark', () => {
    expect(normalizeTheme(THEME_DARK, true)).toBe(THEME_DARK);
    expect(normalizeTheme(THEME_LIGHT, false)).toBe(THEME_LIGHT);
  });

  it('allows system only when supported', () => {
    expect(normalizeTheme(THEME_SYSTEM, true)).toBe(THEME_SYSTEM);
    expect(normalizeTheme(THEME_SYSTEM, false)).toBe(THEME_LIGHT);
  });

  it('falls back by allowSystem for unknown values', () => {
    expect(normalizeTheme('bogus', true)).toBe(THEME_SYSTEM);
    expect(normalizeTheme(undefined, false)).toBe(THEME_LIGHT);
  });
});

describe('cycle helpers', () => {
  it('includes system only when allowed', () => {
    expect(themeCycle(true)).toEqual([THEME_LIGHT, THEME_DARK, THEME_SYSTEM]);
    expect(themeCycle(false)).toEqual([THEME_LIGHT, THEME_DARK]);
  });

  it('advances and wraps', () => {
    expect(nextTheme(THEME_LIGHT, true)).toBe(THEME_DARK);
    expect(nextTheme(THEME_DARK, true)).toBe(THEME_SYSTEM);
    expect(nextTheme(THEME_SYSTEM, true)).toBe(THEME_LIGHT);
    expect(nextTheme(THEME_DARK, false)).toBe(THEME_LIGHT);
  });
});

describe('labels and icons', () => {
  it('returns metadata with safe fallback', () => {
    expect(themeLabel(THEME_SYSTEM)).toBe('System');
    expect(themeLabel('bogus')).toBe('Light');
    expect(themeIcon(THEME_DARK)).toBeTruthy();
    expect(themeIcon('bogus')).toBe(themeIcon(THEME_LIGHT));
  });
});

describe('applyTheme', () => {
  it('sets data-theme for explicit preferences', () => {
    const doc = makeDoc();
    applyTheme(THEME_DARK, doc);
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('removes data-theme for system', () => {
    const doc = makeDoc();
    applyTheme(THEME_DARK, doc);
    applyTheme(THEME_SYSTEM, doc);
    expect(doc.documentElement.getAttribute('data-theme')).toBe(null);
  });

  it('no-ops without a document', () => {
    expect(() => applyTheme(THEME_DARK, undefined)).not.toThrow();
  });
});

describe('applyThemeToElement', () => {
  function makeEl() {
    const attrs = {};
    return {
      setAttribute: (name, value) => {
        attrs[name] = value;
      },
      removeAttribute: (name) => {
        delete attrs[name];
      },
      getAttribute: (name) => (name in attrs ? attrs[name] : null),
    };
  }

  it('sets data-theme for explicit preferences', () => {
    const el = makeEl();
    applyThemeToElement(el, THEME_DARK);
    expect(el.getAttribute('data-theme')).toBe('dark');
    applyThemeToElement(el, THEME_LIGHT);
    expect(el.getAttribute('data-theme')).toBe('light');
  });

  it('removes data-theme for system', () => {
    const el = makeEl();
    applyThemeToElement(el, THEME_DARK);
    applyThemeToElement(el, THEME_SYSTEM);
    expect(el.getAttribute('data-theme')).toBe(null);
  });

  it('no-ops on a missing or non-element value', () => {
    expect(() => applyThemeToElement(null, THEME_DARK)).not.toThrow();
    expect(() => applyThemeToElement({}, THEME_DARK)).not.toThrow();
  });
});

describe('storage helpers', () => {
  it('reads and writes via chrome.storage.local', async () => {
    const store = {};
    vi.stubGlobal('chrome', {
      runtime: { lastError: null },
      storage: {
        local: {
          get: (key, cb) => cb({ [key]: store[key] }),
          set: (items, cb) => {
            Object.assign(store, items);
            cb();
          },
        },
      },
    });
    await setStoredTheme(THEME_DARK);
    expect(store[THEME_KEY]).toBe(THEME_DARK);
    expect(await getStoredTheme()).toBe(THEME_DARK);
    vi.unstubAllGlobals();
  });

  it('resolves undefined on lastError', async () => {
    vi.stubGlobal('chrome', {
      runtime: { lastError: { message: 'fail' } },
      storage: { local: { get: (key, cb) => cb({}) } },
    });
    expect(await getStoredTheme()).toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('resolves safely when chrome is unavailable', async () => {
    vi.stubGlobal('chrome', undefined);
    expect(await getStoredTheme()).toBeUndefined();
    // setStoredTheme now matches its siblings (verboseLogSettings,
    // highlightSettings): a failed write rejects rather than reporting a
    // silent success.
    await expect(setStoredTheme(THEME_LIGHT)).rejects.toThrow();
    vi.unstubAllGlobals();
  });
});

describe('createThemeController', () => {
  it('initializes from storage, applies, and notifies subscribers', async () => {
    const doc = makeDoc();
    const controller = createThemeController({
      doc,
      win: winWithDark(true),
      getStored: () => Promise.resolve(THEME_DARK),
      setStored: vi.fn().mockResolvedValue(undefined),
    });
    const seen = [];
    controller.subscribe((state) => seen.push(state.preference));

    expect(controller.allowSystem).toBe(true);
    await controller.init();

    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(seen[seen.length - 1]).toBe(THEME_DARK);
  });

  it('persists and applies on setPreference', async () => {
    const doc = makeDoc();
    const setStored = vi.fn().mockResolvedValue(undefined);
    const controller = createThemeController({
      doc,
      win: winWithDark(false),
      getStored: () => Promise.resolve(undefined),
      setStored,
    });

    await controller.setPreference(THEME_LIGHT);
    expect(doc.documentElement.getAttribute('data-theme')).toBe('light');
    expect(setStored).toHaveBeenCalledWith(THEME_LIGHT);

    await controller.setPreference(THEME_SYSTEM);
    expect(doc.documentElement.getAttribute('data-theme')).toBe(null);
  });

  it('keeps the applied preference and warns when persisting fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc = makeDoc();
    const setStored = vi.fn().mockRejectedValue(new Error('storage.set failed'));
    const controller = createThemeController({
      doc,
      win: winWithDark(false),
      getStored: () => Promise.resolve(undefined),
      setStored,
    });

    await expect(controller.setPreference(THEME_DARK)).resolves.toMatchObject({
      preference: THEME_DARK,
    });
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('notifies subscribers exactly once per setPreference call', async () => {
    const doc = makeDoc();
    const controller = createThemeController({
      doc,
      win: winWithDark(false),
      getStored: () => Promise.resolve(undefined),
      setStored: vi.fn().mockResolvedValue(undefined),
    });
    const fn = vi.fn();
    controller.subscribe(fn);
    fn.mockClear();

    await controller.setPreference(THEME_DARK);

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('cycles through preferences', async () => {
    const doc = makeDoc();
    const controller = createThemeController({
      doc,
      win: winWithDark(false),
      getStored: () => Promise.resolve(THEME_LIGHT),
      setStored: vi.fn().mockResolvedValue(undefined),
    });
    await controller.init();
    expect(controller.current().preference).toBe(THEME_LIGHT);
    await controller.cycle();
    expect(controller.current().preference).toBe(THEME_DARK);
  });

  it('defaults to light and excludes system when unsupported', async () => {
    const doc = makeDoc();
    const controller = createThemeController({
      doc,
      win: {},
      getStored: () => Promise.resolve(THEME_SYSTEM),
      setStored: vi.fn().mockResolvedValue(undefined),
    });
    expect(controller.allowSystem).toBe(false);
    await controller.init();
    expect(controller.current().preference).toBe(THEME_LIGHT);
  });

  it('unsubscribe stops notifications', async () => {
    const controller = createThemeController({
      doc: makeDoc(),
      win: winWithDark(false),
      getStored: () => Promise.resolve(THEME_LIGHT),
      setStored: vi.fn().mockResolvedValue(undefined),
    });
    const fn = vi.fn();
    const unsubscribe = controller.subscribe(fn);
    fn.mockClear();
    unsubscribe();
    await controller.setPreference(THEME_DARK);
    expect(fn).not.toHaveBeenCalled();
  });

  it('watch re-applies the theme on external storage changes', () => {
    let handler = null;
    vi.stubGlobal('chrome', {
      storage: {
        onChanged: {
          addListener: (fn) => {
            handler = fn;
          },
          removeListener: vi.fn(),
        },
      },
    });
    const doc = makeDoc();
    const controller = createThemeController({
      doc,
      win: winWithDark(false),
      getStored: () => Promise.resolve(THEME_LIGHT),
      setStored: vi.fn().mockResolvedValue(undefined),
    });
    const unwatch = controller.watch();
    expect(typeof handler).toBe('function');

    handler({ [THEME_KEY]: { newValue: THEME_DARK } }, 'local');
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');

    // Ignores unrelated keys and non-local areas.
    handler({ 'pagetollm:other': { newValue: 'x' } }, 'local');
    handler({ [THEME_KEY]: { newValue: THEME_LIGHT } }, 'sync');
    expect(doc.documentElement.getAttribute('data-theme')).toBe('dark');

    unwatch();
    vi.unstubAllGlobals();
  });

  it('watch returns a noop when storage is unavailable', () => {
    vi.stubGlobal('chrome', undefined);
    const controller = createThemeController({
      doc: makeDoc(),
      win: winWithDark(false),
      getStored: () => Promise.resolve(THEME_LIGHT),
      setStored: vi.fn().mockResolvedValue(undefined),
    });
    expect(() => controller.watch()()).not.toThrow();
    vi.unstubAllGlobals();
  });
});
