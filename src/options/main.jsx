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
createRoot(rootEl).render(
  <ErrorBoundary label="The options page">
    <OptionsApp
      fileHost={browserFileHost}
      pageHost={browserPageHost}
      scheduler={browserScheduler}
      store={browserLocalStore}
    />
  </ErrorBoundary>,
);
