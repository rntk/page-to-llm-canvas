// Small display-text helpers shared by project components.

export const UNTITLED_PROJECT = 'Untitled project';

/** Lets the header's Chat toggle reference the project chat panel. */
export const PROJECT_CHAT_PANEL_ID = 'project-chat-panel';

/**
 * @param {string|undefined} url
 * @returns {string} The URL's hostname, or the raw input when unparseable.
 */
export function hostnameOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url || '';
  }
}
