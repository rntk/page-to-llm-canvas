import { createStoredSetting } from '../shared/runtime/localStore.js';

export const HIGHLIGHT_COLOR_KEY = 'pagetollm-highlight-color';
export const DEFAULT_HIGHLIGHT_COLOR = '#3a404d';
const HIGHLIGHT_BACKGROUND_ALPHA = 0.12;
const HIGHLIGHT_HOVER_BACKGROUND_ALPHA = 0.08;
// Stronger tint for the "active"/hovered sentence highlight, which must read as
// more prominent than the resting highlight (HIGHLIGHT_BACKGROUND_ALPHA).
const HIGHLIGHT_ACTIVE_BACKGROUND_ALPHA = 0.2;

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
    activeBackgroundAlpha = HIGHLIGHT_ACTIVE_BACKGROUND_ALPHA,
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
  el.style.setProperty(
    '--pagetollm-highlight-active-color',
    highlightColorWithAlpha(normalized, activeBackgroundAlpha),
  );
}

const setting = createStoredSetting({
  key: HIGHLIGHT_COLOR_KEY,
  defaultValue: DEFAULT_HIGHLIGHT_COLOR,
  normalize: normalizeHighlightColor,
});

export function getStoredHighlightColor() {
  return setting.read();
}

export function setStoredHighlightColor(color) {
  return setting.write(color);
}
