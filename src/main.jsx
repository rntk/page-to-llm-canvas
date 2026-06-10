import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import HierarchyApp from './hierarchy/HierarchyApp.jsx';
import './modal.css';
import { parseModalRoute } from './modalRoute.js';

const { key, view } = parseModalRoute(window.location.search);
const container = document.getElementById('pagetollm-root');
const root = createRoot(container);
root.render(view === 'hierarchy' ? <HierarchyApp initialKey={key} /> : <App initialKey={key} />);
