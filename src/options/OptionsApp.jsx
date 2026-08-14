import React, { useCallback, useEffect, useState } from 'react';
import { GeneralSettingsPanel } from './GeneralSettingsPanel.jsx';
import { LlmMetricsSection } from './LlmMetricsSection.jsx';
import { ChatToolMetricsSection } from './ChatToolMetricsSection.jsx';
import { ParserMetricsSection } from './ParserMetricsSection.jsx';
import { ResplitMetricsSection } from './ResplitMetricsSection.jsx';
import { ProvidersSection } from './ProvidersSection.jsx';
import { RecordsSection } from './RecordsSection.jsx';
import { DataManagementSection } from './DataManagementSection.jsx';

const OPTION_TABS = [
  { id: 'general', label: 'General' },
  { id: 'providers', label: 'Providers' },
  { id: 'records', label: 'Records' },
  { id: 'data', label: 'Data' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

function tabFromHash() {
  if (typeof window === 'undefined') return OPTION_TABS[0].id;
  const candidate = window.location.hash.slice(1);
  return OPTION_TABS.some((tab) => tab.id === candidate) ? candidate : OPTION_TABS[0].id;
}

export function OptionsApp({ store, scheduler, fileHost, pageHost }) {
  const [activeTab, setActiveTab] = useState(tabFromHash);
  const [dataVersion, setDataVersion] = useState(0);

  const selectTab = useCallback((tabId, { focus = false } = {}) => {
    setActiveTab(tabId);
    if (typeof window !== 'undefined' && window.location.hash !== `#${tabId}`) {
      window.history.replaceState(null, '', `#${tabId}`);
    }
    if (focus) document.getElementById(`options-tab-${tabId}`)?.focus();
  }, []);

  useEffect(() => {
    const handleHashChange = () => setActiveTab(tabFromHash());
    window.addEventListener('hashchange', handleHashChange);
    return () => window.removeEventListener('hashchange', handleHashChange);
  }, []);

  const handleTabKeyDown = (event) => {
    const currentIndex = OPTION_TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + 1) % OPTION_TABS.length;
    else if (event.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + OPTION_TABS.length) % OPTION_TABS.length;
    } else if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = OPTION_TABS.length - 1;
    else return;
    event.preventDefault();
    selectTab(OPTION_TABS[nextIndex].id, { focus: true });
  };

  return (
    <main className="options-shell">
      <div className="page-header">
        <div>
          <h1>PageToLLM Canvas</h1>
          <div className="page-kicker">Settings</div>
        </div>
      </div>

      <div className="options-tabs" role="tablist" aria-label="Settings sections">
        {OPTION_TABS.map((tab) => (
          <button
            id={`options-tab-${tab.id}`}
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`options-panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => selectTab(tab.id)}
            onKeyDown={handleTabKeyDown}
          >
            {tab.label}
          </button>
        ))}
      </div>

      <section
        id="options-panel-general"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="options-tab-general"
        hidden={activeTab !== 'general'}
      >
        <GeneralSettingsPanel scheduler={scheduler} store={store} />
      </section>

      <div
        id="options-panel-providers"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="options-tab-providers"
        hidden={activeTab !== 'providers'}
      >
        <ProvidersSection key={`providers-${dataVersion}`} />
      </div>

      <section
        id="options-panel-records"
        className="tab-panel section"
        role="tabpanel"
        aria-labelledby="options-tab-records"
        hidden={activeTab !== 'records'}
      >
        <RecordsSection key={`records-${dataVersion}`} fileHost={fileHost} pageHost={pageHost} />
      </section>

      <section
        id="options-panel-data"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="options-tab-data"
        hidden={activeTab !== 'data'}
      >
        <DataManagementSection onDataChanged={() => setDataVersion((version) => version + 1)} />
      </section>

      <div
        id="options-panel-diagnostics"
        className="tab-panel"
        role="tabpanel"
        aria-labelledby="options-tab-diagnostics"
        hidden={activeTab !== 'diagnostics'}
      >
        <ParserMetricsSection store={store} />
        <ResplitMetricsSection store={store} />
        <LlmMetricsSection store={store} />
        <ChatToolMetricsSection store={store} />
      </div>
    </main>
  );
}
