import React, { useState } from 'react';
import { CARD_HEIGHT, CARD_WIDTH } from './canvasLayout.js';
import { hostnameOf } from './projectText.js';

function FaviconTile({ tab, title }) {
  // Remember which URL failed so a changed favicon gets another chance.
  const [failedUrl, setFailedUrl] = useState(null);
  if (tab.favIconUrl && failedUrl !== tab.favIconUrl) {
    return (
      <img
        className="tab-card-favicon"
        src={tab.favIconUrl}
        alt=""
        draggable={false}
        onError={() => setFailedUrl(tab.favIconUrl)}
      />
    );
  }
  const letter = (hostnameOf(tab.url).replace(/^www\./, '') || title).charAt(0).toUpperCase();
  return (
    <span className="tab-card-favicon tab-card-favicon-fallback" aria-hidden="true">
      {letter || '?'}
    </span>
  );
}

/**
 * Placeholder card for one tab in the group. The body is reserved for future
 * per-page content and chat.
 *
 * @param {object} props
 * @param {{id: number, title?: string, url?: string, favIconUrl?: string, active?: boolean, status?: string}} props.tab
 * @param {{activateTab: function(number): Promise<void>}} props.tabsHost
 * @param {function(import('react').PointerEvent): void} [props.onDragStart]
 *   Called when a drag starts on the card header.
 */
export function TabCard({ tab, tabsHost, onDragStart }) {
  const [goError, setGoError] = useState(false);
  const title = tab.title || tab.url || 'Untitled tab';
  const loading = tab.status === 'loading';

  const goToTab = () => {
    setGoError(false);
    Promise.resolve()
      .then(() => tabsHost.activateTab(tab.id))
      .catch(() => setGoError(true));
  };

  return (
    <article
      className={`tab-card${tab.active ? ' is-active' : ''}`}
      style={{ width: CARD_WIDTH, height: CARD_HEIGHT }}
      data-tab-id={tab.id}
      aria-current={tab.active ? 'true' : undefined}
    >
      <header className="tab-card-header" onPointerDown={onDragStart}>
        <FaviconTile tab={tab} title={title} />
        <div className="tab-card-heading">
          <h2 className="tab-card-title" title={title}>
            {title}
          </h2>
          <p className="tab-card-host">{hostnameOf(tab.url)}</p>
        </div>
        {loading && <span className="tab-card-loading" role="status" aria-label="Loading" />}
      </header>
      <div className="tab-card-body">Page content &amp; chat will appear here</div>
      <footer className="tab-card-footer">
        {goError && <span className="tab-card-error">Could not switch to tab</span>}
        <button type="button" onClick={goToTab}>
          Go to tab
        </button>
      </footer>
    </article>
  );
}
