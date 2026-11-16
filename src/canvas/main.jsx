import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HierarchyApp from '../hierarchy/HierarchyApp.jsx';
import TopicsTreeApp from '../topics-tree/TopicsTreeApp.jsx';
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

// Apply the saved theme to this iframe and keep it synced with changes made
// elsewhere. "system" is resolved by modal.css's prefers-color-scheme query.
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
// `window` is this iframe's, so the boundary's Reload fallback leaves the host page untouched.
const routes = {
  hierarchy: { label: 'The hierarchy view', App: HierarchyApp },
  tree: { label: 'The topics tree view', App: TopicsTreeApp },
};
const route = routes[view];
root.render(
  <ErrorBoundary label={route ? route.label : 'The canvas view'}>
    {route ? (
      <route.App
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
