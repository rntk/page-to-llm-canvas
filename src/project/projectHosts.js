// Browser-backed capabilities for the project page, injected so components
// stay testable without a `chrome` global.

/**
 * @param {object} [chromeApi] The `chrome` namespace.
 */
export function createProjectHosts(chromeApi = globalThis.chrome) {
  const tabsHost = Object.freeze({
    /**
     * Activates a tab and focuses its window.
     * @param {number} tabId
     */
    async activateTab(tabId) {
      const tab = await chromeApi.tabs.update(tabId, { active: true });
      if (tab && typeof tab.windowId === 'number' && chromeApi.windows?.update) {
        await chromeApi.windows.update(tab.windowId, { focused: true });
      }
    },
  });

  const pageHost = Object.freeze({
    /** Opens the extension options page. */
    openOptions() {
      if (typeof chromeApi?.runtime?.openOptionsPage === 'function') {
        return chromeApi.runtime.openOptionsPage();
      }
      if (typeof chromeApi?.runtime?.getURL === 'function') {
        globalThis.window?.open(chromeApi.runtime.getURL('options.html#projects'), '_blank');
      }
      return undefined;
    },
  });

  return { tabsHost, pageHost };
}
