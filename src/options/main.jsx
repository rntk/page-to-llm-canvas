import React from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { browserLocalStore } from '../shared/runtime/localStore.js';
import { subscribeRecordChanges } from './recordChanges.js';
import {
  browserFileHost,
  browserPageHost,
  browserScheduler,
} from '../shared/runtime/browserHosts.js';

const rootEl = document.getElementById('options-root');
// Export the root so tests can unmount effects before re-importing this entrypoint.
export const root = createRoot(rootEl);
root.render(
  <ErrorBoundary label="The options page">
    <OptionsApp
      fileHost={browserFileHost}
      pageHost={browserPageHost}
      scheduler={browserScheduler}
      store={browserLocalStore}
      subscribeRecords={subscribeRecordChanges}
    />
  </ErrorBoundary>,
);
