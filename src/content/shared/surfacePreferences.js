import {
  getStoredTheme,
  systemThemeSupported,
  normalizeTheme,
  applyThemeToElement,
  THEME_KEY,
  THEME_SYSTEM,
} from '../../shared/runtime/theme.js';
import {
  HIGHLIGHT_COLOR_KEY,
  DEFAULT_HIGHLIGHT_COLOR,
  getStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
  clearHighlightColorFromElement,
} from '../../highlights/highlightSettings.js';
import { browserLocalStore } from '../../shared/runtime/localStore.js';

// The injected toolbar/rail tokens are scoped to their host elements (not the
// host page's :root), so we tag those elements with the saved preference and
// let content.css flip the palette. The "system" case is handled by CSS, so a
// failed/missing read just falls back to system. Cached at injection so the
// elements can be tagged synchronously on creation (no flash).
let cachedThemePreference = THEME_SYSTEM;
let cachedHighlightColor = DEFAULT_HIGHLIGHT_COLOR;
let unsubscribePreferenceStorage = null;
let mountedContentSurfaceCount = 0;
// One generation counter per preference, not one shared counter: a change event
// for one key must only invalidate the in-flight read for THAT key, or the other
// key's pending read is dropped and stays at its default until the next resync.
let themeSyncId = 0;
let highlightColorSyncId = 0;
let didInit = false;
let initPromise = null;
let contentDocumentRef = null;

// Controllers own their host elements; they register a getter here so a theme
// or highlight-color change can re-tag surfaces that are already mounted
// WITHOUT this module importing the controllers (which would create cycles).
const themedSurfaceProviders = new Set();

/**
 * Register a live getter for a themed surface. The getter returns the current
 * host element (or a falsy value when the surface is not mounted). Returns an
 * unregister function.
 * @param {function(): (HTMLElement|null|undefined|false)} getEl
 * @returns {function(): void}
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

function getHighlightTargetDocument() {
  if (contentDocumentRef) return contentDocumentRef;
  if (typeof document !== 'undefined') return document;
  return null;
}

function getHighlightTargetElement() {
  const doc = getHighlightTargetDocument();
  return doc ? doc.documentElement : null;
}

function refreshMountedHighlightColor() {
  if (mountedContentSurfaceCount === 0) return;
  const target = getHighlightTargetElement();
  if (target) applyHighlightColorToElement(target, cachedHighlightColor);
  for (const getEl of themedSurfaceProviders) {
    const el = getEl();
    if (el) applyContentHighlightColor(el);
  }
}

function clearMountedHighlightColor() {
  const target = getHighlightTargetElement();
  if (target) clearHighlightColorFromElement(target);
}

/**
 * Kick off the initial preference reads. Importing this module must not start
 * async work. Lazy surface factories await the returned promise so their first
 * render is tagged with the stored preferences rather than briefly flashing
 * the defaults.
 */
export function init(contentDocument) {
  if (contentDocument) contentDocumentRef = contentDocument;
  if (!didInit) {
    didInit = true;
    initPromise = syncPreferenceCacheFromStorage();
  }
  return initPromise;
}

function syncPreferenceCacheFromStorage() {
  const themeReadId = ++themeSyncId;
  const highlightColorReadId = ++highlightColorSyncId;
  const themeRead = getStoredTheme()
    .then((stored) => {
      if (themeReadId !== themeSyncId) return;
      setCachedThemePreference(stored);
      refreshMountedContentTheme();
    })
    .catch((err) => {
      console.warn('PageToLLM content theme load failed:', err);
    });
  const highlightColorRead = getStoredHighlightColor()
    .then((stored) => {
      if (highlightColorReadId !== highlightColorSyncId) return;
      setCachedHighlightColor(stored);
      refreshMountedHighlightColor();
    })
    .catch((err) => {
      console.warn('PageToLLM content highlight color load failed:', err);
    });
  return Promise.all([themeRead, highlightColorRead]);
}

function handlePreferenceStorageChange(changes) {
  if (!changes) return;
  const themeChange = changes[THEME_KEY];
  const highlightColorChange = changes[HIGHLIGHT_COLOR_KEY];
  if (!themeChange && !highlightColorChange) return;
  if (themeChange) {
    themeSyncId += 1;
    setCachedThemePreference(themeChange.newValue);
    refreshMountedContentTheme();
  }
  if (highlightColorChange) {
    highlightColorSyncId += 1;
    setCachedHighlightColor(highlightColorChange.newValue);
    refreshMountedHighlightColor();
  }
}

function attachPreferenceStorageListener() {
  if (unsubscribePreferenceStorage) return;
  unsubscribePreferenceStorage = browserLocalStore.subscribeChanges(
    [THEME_KEY, HIGHLIGHT_COLOR_KEY],
    handlePreferenceStorageChange,
  );
  void syncPreferenceCacheFromStorage();
}

function detachPreferenceStorageListener() {
  if (!unsubscribePreferenceStorage) return;
  unsubscribePreferenceStorage();
  unsubscribePreferenceStorage = null;
}

export function trackMountedSurface(contentDocument) {
  if (contentDocument) contentDocumentRef = contentDocument;
  const wasZero = mountedContentSurfaceCount === 0;
  mountedContentSurfaceCount += 1;
  if (wasZero) {
    const target = getHighlightTargetElement();
    if (target) applyHighlightColorToElement(target, cachedHighlightColor);
  }
  attachPreferenceStorageListener();
}

export function untrackMountedSurface() {
  const prevCount = mountedContentSurfaceCount;
  mountedContentSurfaceCount = Math.max(0, mountedContentSurfaceCount - 1);
  if (prevCount > 0 && mountedContentSurfaceCount === 0) {
    detachPreferenceStorageListener();
    highlightColorSyncId += 1;
    clearMountedHighlightColor();
    contentDocumentRef = null;
  }
}
