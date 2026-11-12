// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mounts = vi.hoisted(() => ({ providers: 0, records: 0 }));

vi.mock('./GeneralSettingsPanel.jsx', () => ({ GeneralSettingsPanel: () => null }));
vi.mock('./LlmMetricsSection.jsx', () => ({ LlmMetricsSection: () => null }));
vi.mock('./ChatToolMetricsSection.jsx', () => ({ ChatToolMetricsSection: () => null }));
vi.mock('./ParserMetricsSection.jsx', () => ({ ParserMetricsSection: () => null }));
vi.mock('./ProjectsSection.jsx', () => ({ ProjectsSection: () => null }));
vi.mock('./ProvidersSection.jsx', async () => {
  const React = await import('react');
  return {
    ProvidersSection: function ProvidersSection() {
      React.useEffect(() => {
        mounts.providers += 1;
      }, []);
      return <input id="draft" />;
    },
  };
});
vi.mock('./RecordsSection.jsx', async () => {
  const React = await import('react');
  return {
    RecordsSection: function RecordsSection() {
      React.useEffect(() => {
        mounts.records += 1;
      }, []);
      return null;
    },
  };
});
vi.mock('./DataManagementSection.jsx', () => ({
  DataManagementSection: ({ onDataChanged }) => (
    <div>
      <button id="delete-pages" onClick={() => onDataChanged()}>
        pages
      </button>
      <button id="reset-all" onClick={() => onDataChanged({ providersChanged: true })}>
        reset
      </button>
    </div>
  ),
}));

import { OptionsApp } from './OptionsApp.jsx';

let container;
let root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mounts.providers = 0;
  mounts.records = 0;
  window.location.hash = '#providers';
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  window.location.hash = '';
});

async function mountApp() {
  await act(async () => {
    root.render(<OptionsApp store={{}} scheduler={{}} />);
  });
}

async function visit(tabId) {
  await act(async () => {
    document.getElementById(`options-tab-${tabId}`).click();
  });
}

describe('OptionsApp data-change remounting', () => {
  it('keeps the Providers form mounted after page data is deleted but remounts Records', async () => {
    await mountApp();
    await visit('records');
    await visit('data');
    expect(mounts.providers).toBe(1);
    expect(mounts.records).toBe(1);
    const draft = container.querySelector('#draft');

    await act(async () => {
      container.querySelector('#delete-pages').click();
    });
    expect(container.querySelector('#draft')).toBe(draft);
    expect(mounts.providers).toBe(1);
    expect(mounts.records).toBe(2);
  });

  it('remounts Providers after a full extension reset', async () => {
    await mountApp();
    await visit('data');
    const draft = container.querySelector('#draft');

    await act(async () => {
      container.querySelector('#reset-all').click();
    });
    expect(container.querySelector('#draft')).not.toBe(draft);
    expect(mounts.providers).toBe(2);
  });
});
