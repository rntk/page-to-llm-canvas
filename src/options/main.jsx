import React from 'react';
import { createRoot } from 'react-dom/client';
import { OptionsApp } from './OptionsApp.jsx';

const rootEl = document.getElementById('options-root');
createRoot(rootEl).render(<OptionsApp />);
