// Shared light/dark/system theme handling for the popup and options pages.
//
// The "system" preference is resolved by CSS (a `prefers-color-scheme` media
// query) rather than JavaScript: when the user picks "system" we simply remove
// the `data-theme` attribute and let the stylesheet follow the OS/browser. This
// keeps the live OS re-render free (no matchMedia listener to maintain) and
// avoids a flash of the wrong colors for system users on first paint.

import { createLogger } from './log.js';
import { getLocalItems, setLocalItems, subscribeLocalKey } from './localStore.js';

const log = createLogger();

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
 * @param {Window|undefined} [win] Window-like object to query.
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
 * @param {string} value Stored theme preference.
 * @param {boolean} allowSystem Whether the system preference is supported.
 */
export function normalizeTheme(value, allowSystem) {
  if (value === THEME_DARK) return THEME_DARK;
  if (value === THEME_LIGHT) return THEME_LIGHT;
  if (value === THEME_SYSTEM && allowSystem) return THEME_SYSTEM;
  return allowSystem ? THEME_SYSTEM : THEME_LIGHT;
}

/** Ordered cycle used by the popup's single toggle button.
 * @param {boolean} allowSystem Whether to include the system preference.
 */
export function themeCycle(allowSystem) {
  return allowSystem ? [THEME_LIGHT, THEME_DARK, THEME_SYSTEM] : [THEME_LIGHT, THEME_DARK];
}

/** Next preference when cycling the popup toggle.
 * @param {string} current Current preference.
 * @param {boolean} allowSystem Whether to include the system preference.
 */
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
 * @param {Element} el Element receiving the preference.
 * @param {string} preference Theme preference.
 */
export function applyThemeToElement(el, preference) {
  if (!el || typeof el.setAttribute !== 'function') return;
  if (preference === THEME_LIGHT || preference === THEME_DARK) {
    el.setAttribute('data-theme', preference);
  } else if (typeof el.removeAttribute === 'function') {
    el.removeAttribute('data-theme');
  }
}

/**
 * Applies a preference to the document root. Explicit light/dark set
 * `data-theme`; "system" removes it so the `prefers-color-scheme` media query
 * takes over.
 * @param {string} preference Theme preference.
 * @param {Document|undefined} [doc] Document-like object to update.
 */
export function applyTheme(
  preference,
  doc = typeof document !== 'undefined' ? document : undefined,
) {
  applyThemeToElement(doc && doc.documentElement, preference);
}

export function getStoredTheme() {
  // Stored themes are normalized by the caller, so an unreadable value and an
  // unset one are the same thing here: undefined.
  return Promise.resolve()
    .then(() => getLocalItems(THEME_KEY))
    .then((items) => (items ? items[THEME_KEY] : undefined))
    .catch(() => undefined);
}

export function setStoredTheme(preference) {
  return Promise.resolve()
    .then(() => setLocalItems({ [THEME_KEY]: preference }))
    .catch((error) => {
      throw error instanceof Error ? error : new Error(String(error));
    });
}

/**
 * Creates a small controller that owns the current preference, applies it to
 * the document, persists changes, and notifies subscribers. Dependencies are
 * injectable for testing.
 * @param {object} [options]
 * @param {Document} [options.doc]
 * @param {Window} [options.win]
 * @param {Function} [options.getStored]
 * @param {Function} [options.setStored]
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
    // Keep the applied preference even if persistence fails — reverting the
    // just-rendered choice with no explanation would be worse than a theme
    // that silently fails to survive a reload. setStored now rejects on a
    // storage error (matching its siblings' contract), so callers of
    // setPreference/cycle must not be left with an unhandled rejection; log
    // it here instead since this is the one place all callers funnel through.
    try {
      await setStored(preference);
    } catch (error) {
      log.warn('failed to persist theme preference:', error);
    }
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

  // Keep this document in sync when the preference is changed elsewhere (e.g.
  // the popup/options page) while this view is open. Returns an unsubscribe.
  function watch() {
    return subscribeLocalKey(THEME_KEY, (newValue) => {
      preference = normalizeTheme(newValue, allowSystem);
      render();
    });
  }

  return { init, setPreference, cycle, current, subscribe, watch, allowSystem };
}
