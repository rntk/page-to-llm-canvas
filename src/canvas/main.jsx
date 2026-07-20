import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HierarchyApp from '../hierarchy/HierarchyApp.jsx';
import './modal.css';
import { parseModalRoute } from './modalRoute.js';
import { createThemeController } from '../shared/runtime/theme.js';
import {
  HIGHLIGHT_COLOR_KEY,
  getStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
} from '../highlights/highlightSettings.js';

// Apply the saved light/dark/system preference to this iframe document, and
// keep it in sync if the preference changes (from the popup/options) while a
// canvas/hierarchy view is open. The "system" case is resolved by modal.css's
// prefers-color-scheme media query.
const themeController = createThemeController();
void themeController.init();
themeController.watch();

void getStoredHighlightColor().then((color) => {
  applyHighlightColorToElement(document.documentElement, color);
});
try {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes || !changes[HIGHLIGHT_COLOR_KEY]) return;
    applyHighlightColorToElement(
      document.documentElement,
      normalizeHighlightColor(changes[HIGHLIGHT_COLOR_KEY].newValue),
    );
  });
} catch (_) {
  /* noop */
}

const { key, view } = parseModalRoute(window.location.search);
const container = document.getElementById('pagetollm-root');
const root = createRoot(container);
root.render(view === 'hierarchy' ? <HierarchyApp initialKey={key} /> : <App initialKey={key} />);
