import React from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { browserLocalStore } from '../shared/runtime/localStore.js';
import {
  browserFileHost,
  browserPageHost,
  browserScheduler,
} from '../shared/runtime/browserHosts.js';

const rootEl = document.getElementById('options-root');
// Exported so tests can `root.unmount()` between cases - this page is only
// ever entered once per real tab, but re-importing this module in tests
// (`vi.resetModules()` + repeated `import('./main.jsx')`) creates a fresh
// root every time; without unmounting the previous one, its effects (e.g.
// the `hashchange` listener in OptionsApp) keep running against later tests.
export const root = createRoot(rootEl);
root.render(
  <ErrorBoundary label="The options page">
    <OptionsApp
      fileHost={browserFileHost}
      pageHost={browserPageHost}
      scheduler={browserScheduler}
      store={browserLocalStore}
    />
  </ErrorBoundary>,
);
