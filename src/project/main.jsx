import React from 'react';
import { createRoot } from 'react-dom/client';
import { ProjectApp } from './ProjectApp.jsx';
import ErrorBoundary from '../components/ErrorBoundary.jsx';
import { browserProjectsApi, subscribeProjectChanges } from './projectsApi.js';
import { browserScheduler } from '../shared/runtime/browserHosts.js';
import { createThemeController } from '../shared/runtime/theme.js';
import { createProjectHosts } from './projectHosts.js';

// Apply the saved light/dark/system preference and follow changes made in the
// popup/options while this page is open.
const themeController = createThemeController();
void themeController.init();
themeController.watch();

const { tabsHost, pageHost } = createProjectHosts();
const projectId = new URLSearchParams(location.search).get('id');
const rootEl = document.getElementById('project-root');
// Export the root so tests can unmount it before re-importing this entrypoint.
export const root = createRoot(rootEl);
root.render(
  <ErrorBoundary label="The project page">
    <ProjectApp
      projectId={projectId}
      api={browserProjectsApi}
      subscribe={subscribeProjectChanges}
      tabsHost={tabsHost}
      pageHost={pageHost}
      scheduler={browserScheduler}
    />
  </ErrorBoundary>,
);
