export const HIGHLIGHT_COLOR_KEY = 'pagetollm-highlight-color';
export const DEFAULT_HIGHLIGHT_COLOR = '#3a404d';
export const HIGHLIGHT_BACKGROUND_ALPHA = 0.12;
export const HIGHLIGHT_HOVER_BACKGROUND_ALPHA = 0.08;

const HEX_COLOR_RE = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeHighlightColor(value) {
  if (typeof value !== 'string') return DEFAULT_HIGHLIGHT_COLOR;
  const trimmed = value.trim();
  if (!HEX_COLOR_RE.test(trimmed)) return DEFAULT_HIGHLIGHT_COLOR;
  if (trimmed.length === 4) {
    const [, r, g, b] = trimmed.toLowerCase();
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return trimmed.toLowerCase();
}

function hexToRgb(color) {
  const normalized = normalizeHighlightColor(color).slice(1);
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

export function highlightColorWithAlpha(color, alpha = HIGHLIGHT_BACKGROUND_ALPHA) {
  const { r, g, b } = hexToRgb(color);
  const safeAlpha = Number.isFinite(alpha) ? Math.min(1, Math.max(0, alpha)) : 1;
  return `rgb(${r} ${g} ${b} / ${safeAlpha})`;
}

export function applyHighlightColorToElement(
  el,
  color,
  {
    backgroundAlpha = HIGHLIGHT_BACKGROUND_ALPHA,
    hoverBackgroundAlpha = HIGHLIGHT_HOVER_BACKGROUND_ALPHA,
  } = {},
) {
  if (!el || !el.style || typeof el.style.setProperty !== 'function') return;
  const normalized = normalizeHighlightColor(color);
  el.style.setProperty('--pagetollm-highlight-base-color', normalized);
  el.style.setProperty(
    '--pagetollm-highlight-color',
    highlightColorWithAlpha(normalized, backgroundAlpha),
  );
  el.style.setProperty(
    '--pagetollm-highlight-hover-color',
    highlightColorWithAlpha(normalized, hoverBackgroundAlpha),
  );
}

export function getStoredHighlightColor() {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(HIGHLIGHT_COLOR_KEY, (items) => {
        if (chrome.runtime && chrome.runtime.lastError) {
          resolve(DEFAULT_HIGHLIGHT_COLOR);
          return;
        }
        resolve(normalizeHighlightColor(items ? items[HIGHLIGHT_COLOR_KEY] : undefined));
      });
    } catch (_) {
      resolve(DEFAULT_HIGHLIGHT_COLOR);
    }
  });
}

export function setStoredHighlightColor(color) {
  const normalized = normalizeHighlightColor(color);
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set({ [HIGHLIGHT_COLOR_KEY]: normalized }, () => resolve(normalized));
    } catch (_) {
      resolve(normalized);
    }
  });
}
