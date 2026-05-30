import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HierarchyApp from './hierarchy/HierarchyApp.jsx';
import './modal.css';

function getLocationParams() {
  try {
    const params = new URLSearchParams(window.location.search);
    return { key: params.get('key') || '', view: params.get('view') || '' };
  } catch (_) {
    return { key: '', view: '' };
  }
}

const { key, view } = getLocationParams();
const container = document.getElementById('pagetollm-root');
const root = createRoot(container);
root.render(view === 'hierarchy' ? <HierarchyApp initialKey={key} /> : <App initialKey={key} />);
