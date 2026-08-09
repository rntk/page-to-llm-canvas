import React from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';

const rootEl = document.getElementById('options-root');
createRoot(rootEl).render(
  <ErrorBoundary label="The options page">
    <OptionsApp />
  </ErrorBoundary>,
);
