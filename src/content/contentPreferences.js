import {
  getStoredTheme,
  systemThemeSupported,
  normalizeTheme,
  applyThemeToElement,
  THEME_KEY,
  THEME_SYSTEM,
} from '../../theme.js';
import {
  HIGHLIGHT_COLOR_KEY,
  DEFAULT_HIGHLIGHT_COLOR,
  getStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
} from '../highlightSettings.js';

// The injected toolbar/rail tokens are scoped to their host elements (not the
// host page's :root), so we tag those elements with the saved preference and
// let content.css flip the palette. The "system" case is handled by CSS, so a
// failed/missing read just falls back to system. Cached at injection so the
// elements can be tagged synchronously on creation (no flash).
let cachedThemePreference = THEME_SYSTEM;
let cachedHighlightColor = DEFAULT_HIGHLIGHT_COLOR;
let storagePreferenceListenerAttached = false;
let mountedContentSurfaceCount = 0;
let preferenceStorageSyncId = 0;

// Controllers own their host elements; they register a getter here so a theme
// or highlight-color change can re-tag surfaces that are already mounted
// WITHOUT this module importing the controllers (which would create cycles).
const themedSurfaceProviders = new Set();

/**
 * Register a live getter for a themed surface. The getter returns the current
 * host element (or a falsy value when the surface is not mounted). Returns an
 * unregister function.
 * @param {() => (HTMLElement | null | undefined | false)} getEl
 * @returns {() => void}
 */
export function registerThemedSurface(getEl) {
  themedSurfaceProviders.add(getEl);
  return () => themedSurfaceProviders.delete(getEl);
}

function setCachedThemePreference(stored) {
  cachedThemePreference = normalizeTheme(stored, systemThemeSupported());
}

function setCachedHighlightColor(stored) {
  cachedHighlightColor = normalizeHighlightColor(stored);
}

export function applyContentTheme(el) {
  applyThemeToElement(el, cachedThemePreference);
}

export function applyContentHighlightColor(el) {
  applyHighlightColorToElement(el, cachedHighlightColor);
}

// Re-tag any already-mounted surfaces. The content script caches the preference
// at injection, so a theme change from the popup/options after the page loaded
// would otherwise be ignored until reload. (OS-level "system" changes are
// handled live by the CSS media query and need no JS.)
function refreshMountedContentTheme() {
  for (const getEl of themedSurfaceProviders) {
    const el = getEl();
    if (el) applyContentTheme(el);
  }
}

function refreshMountedHighlightColor() {
  applyHighlightColorToElement(document.documentElement, cachedHighlightColor);
  for (const getEl of themedSurfaceProviders) {
    const el = getEl();
    if (el) applyContentHighlightColor(el);
  }
}

void getStoredTheme().then((stored) => {
  setCachedThemePreference(stored);
  // A surface opened before this async read resolved was tagged with the
  // default; re-tag it now that the real preference is known.
  refreshMountedContentTheme();
});

void getStoredHighlightColor().then((stored) => {
  setCachedHighlightColor(stored);
  refreshMountedHighlightColor();
});

function syncPreferenceCacheFromStorage() {
  const syncId = ++preferenceStorageSyncId;
  void getStoredTheme().then((stored) => {
    if (syncId !== preferenceStorageSyncId) return;
    setCachedThemePreference(stored);
    refreshMountedContentTheme();
  });
  void getStoredHighlightColor().then((stored) => {
    if (syncId !== preferenceStorageSyncId) return;
    setCachedHighlightColor(stored);
    refreshMountedHighlightColor();
  });
}

function handlePreferenceStorageChange(changes, areaName) {
  if (areaName !== 'local' || !changes) return;
  const themeChange = changes[THEME_KEY];
  const highlightColorChange = changes[HIGHLIGHT_COLOR_KEY];
  if (!themeChange && !highlightColorChange) return;
  preferenceStorageSyncId += 1;
  if (themeChange) {
    setCachedThemePreference(themeChange.newValue);
    refreshMountedContentTheme();
  }
  if (highlightColorChange) {
    setCachedHighlightColor(highlightColorChange.newValue);
    refreshMountedHighlightColor();
  }
}

function attachPreferenceStorageListener() {
  if (storagePreferenceListenerAttached) return;
  try {
    chrome.storage.onChanged.addListener(handlePreferenceStorageChange);
    storagePreferenceListenerAttached = true;
    syncPreferenceCacheFromStorage();
  } catch (_) {
    /* noop */
  }
}

function detachPreferenceStorageListener() {
  if (!storagePreferenceListenerAttached) return;
  try {
    chrome.storage.onChanged.removeListener(handlePreferenceStorageChange);
  } catch (_) {
    /* noop */
  } finally {
    storagePreferenceListenerAttached = false;
  }
}

export function trackMountedSurface() {
  mountedContentSurfaceCount += 1;
  attachPreferenceStorageListener();
}

export function untrackMountedSurface() {
  mountedContentSurfaceCount = Math.max(0, mountedContentSurfaceCount - 1);
  if (mountedContentSurfaceCount === 0) detachPreferenceStorageListener();
}
