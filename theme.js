// Shared light/dark/system theme handling for the popup and options pages.
//
// The "system" preference is resolved by CSS (a `prefers-color-scheme` media
// query) rather than JavaScript: when the user picks "system" we simply remove
// the `data-theme` attribute and let the stylesheet follow the OS/browser. This
// keeps the live OS re-render free (no matchMedia listener to maintain) and
// avoids a flash of the wrong colors for system users on first paint.

// Stored outside the `pagetollm:` prefix on purpose: popup.js refreshes its
// record list for any changed key under that prefix, so a theme write must not
// match it.
export const THEME_KEY = 'pagetollm-theme';

export const THEME_LIGHT = 'light';
export const THEME_DARK = 'dark';
export const THEME_SYSTEM = 'system';

const DARK_MEDIA_QUERY = '(prefers-color-scheme: dark)';

const THEME_META = {
  [THEME_LIGHT]: { label: 'Light', icon: '☀' },
  [THEME_DARK]: { label: 'Dark', icon: '☾' },
  [THEME_SYSTEM]: { label: 'System', icon: '◐' },
};

/**
 * True when the platform can report a color-scheme preference, i.e. when the
 * "System" option is meaningful. Falls back to false on any failure.
 */
export function systemThemeSupported(win = typeof window !== 'undefined' ? window : undefined) {
  if (!win || typeof win.matchMedia !== 'function') return false;
  try {
    return win.matchMedia(DARK_MEDIA_QUERY).media === DARK_MEDIA_QUERY;
  } catch (_) {
    return false;
  }
}

/**
 * Coerces an arbitrary stored value into a valid preference. When "system" is
 * unsupported it is the default; otherwise light is the default.
 */
export function normalizeTheme(value, allowSystem) {
  if (value === THEME_DARK) return THEME_DARK;
  if (value === THEME_LIGHT) return THEME_LIGHT;
  if (value === THEME_SYSTEM && allowSystem) return THEME_SYSTEM;
  return allowSystem ? THEME_SYSTEM : THEME_LIGHT;
}

/** Ordered cycle used by the popup's single toggle button. */
export function themeCycle(allowSystem) {
  return allowSystem ? [THEME_LIGHT, THEME_DARK, THEME_SYSTEM] : [THEME_LIGHT, THEME_DARK];
}

/** Next preference when cycling the popup toggle. */
export function nextTheme(current, allowSystem) {
  const cycle = themeCycle(allowSystem);
  const idx = cycle.indexOf(current);
  return cycle[(idx + 1) % cycle.length];
}

export function themeLabel(preference) {
  return (THEME_META[preference] || THEME_META[THEME_LIGHT]).label;
}

export function themeIcon(preference) {
  return (THEME_META[preference] || THEME_META[THEME_LIGHT]).icon;
}

/**
 * Applies a preference to the document. Explicit light/dark set `data-theme`;
 * "system" removes it so the `prefers-color-scheme` media query takes over.
 */
export function applyTheme(
  preference,
  doc = typeof document !== 'undefined' ? document : undefined,
) {
  const root = doc && doc.documentElement;
  if (!root) return;
  if (preference === THEME_LIGHT || preference === THEME_DARK) {
    root.setAttribute('data-theme', preference);
  } else {
    root.removeAttribute('data-theme');
  }
}

export function getStoredTheme() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(THEME_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(items ? items[THEME_KEY] : undefined);
      });
    } catch (_) {
      resolve(undefined);
    }
  });
}

export function setStoredTheme(preference) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [THEME_KEY]: preference }, () => resolve());
    } catch (_) {
      resolve();
    }
  });
}

/**
 * Creates a small controller that owns the current preference, applies it to
 * the document, persists changes, and notifies subscribers. Dependencies are
 * injectable for testing.
 */
export function createThemeController({
  doc = typeof document !== 'undefined' ? document : undefined,
  win = typeof window !== 'undefined' ? window : undefined,
  getStored = getStoredTheme,
  setStored = setStoredTheme,
} = {}) {
  const allowSystem = systemThemeSupported(win);
  let preference = allowSystem ? THEME_SYSTEM : THEME_LIGHT;
  const listeners = new Set();

  function current() {
    return { preference, allowSystem };
  }

  function render() {
    applyTheme(preference, doc);
    const state = current();
    listeners.forEach((fn) => fn(state));
  }

  async function init() {
    preference = normalizeTheme(await getStored(), allowSystem);
    render();
    return current();
  }

  async function setPreference(value) {
    preference = normalizeTheme(value, allowSystem);
    render();
    await setStored(preference);
    return current();
  }

  function cycle() {
    return setPreference(nextTheme(preference, allowSystem));
  }

  function subscribe(fn) {
    listeners.add(fn);
    fn(current());
    return () => listeners.delete(fn);
  }

  return { init, setPreference, cycle, current, subscribe, allowSystem };
}
