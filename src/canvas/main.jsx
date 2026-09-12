import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HierarchyApp from '../hierarchy/HierarchyApp.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import './modal.css';
import { createThemeController } from '../shared/runtime/theme.js';
import {
  HIGHLIGHT_COLOR_KEY,
  getStoredHighlightColor,
  normalizeHighlightColor,
  applyHighlightColorToElement,
} from '../highlights/highlightSettings.js';
import { browserLocalStore } from '../shared/runtime/localStore.js';
import { createModalHost, parseModalRoute } from './modalHost.js';
import { browserRecordSource } from './recordSource.js';

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
browserLocalStore.subscribe(HIGHLIGHT_COLOR_KEY, (newValue) => {
  applyHighlightColorToElement(document.documentElement, normalizeHighlightColor(newValue));
});

const { key, view } = parseModalRoute(window.location.search);
const container = document.getElementById('pagetollm-root');
const root = createRoot(container);
const modalHost = createModalHost();
// `window` here is our own iframe document, so the boundary's Reload fallback
// recreates the surface without touching the host article page.
root.render(
  <ErrorBoundary label={view === 'hierarchy' ? 'The hierarchy view' : 'The canvas view'}>
    {view === 'hierarchy' ? (
      <HierarchyApp
        initialKey={key}
        recordSource={browserRecordSource}
        onClose={modalHost.onClose}
        onNavigateToSentences={modalHost.onNavigateToSentences}
      />
    ) : (
      <App initialKey={key} recordSource={browserRecordSource} onClose={modalHost.onClose} />
    )}
  </ErrorBoundary>,
);
