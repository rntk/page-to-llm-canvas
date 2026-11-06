import { canonicalPageUrl, pageChatKey } from '../../core/storage/keys.js';
import { normalizeCapturedText } from '../../core/pipeline/capturedText.js';
import { splitSentences } from '../../core/pipeline/sentenceSplitter.js';

// Bounds one capture so a pathological page cannot exhaust worker memory;
// article chat chunks whatever remains to fit the provider's context window.
export const MAX_PAGE_TEXT_CHARS = 500_000;

const READABLE_URL = /^(?:https?|file):/i;
const UNREADABLE_MESSAGE = 'Chat is not available for this kind of page.';
const UNREACHABLE_MESSAGE =
  'Could not read this tab. Open or reload it so the page finishes loading, then try again.';

/**
 * Per-page chat sources for the project canvas. A tab whose URL has a saved
 * record chats against that record (same history, topics and sentences as the
 * on-page chat); any other readable tab chats under a URL-derived page key
 * against text read from the live tab on demand.
 *
 * @param {object} deps
 * @param {{getProjectView: function(string): Promise<{tabs: object[]}>}} deps.projectService
 * @param {function(string): Promise<object|null>} deps.findRecordByUrl
 * @param {function(number, object): Promise<*>} deps.sendTabMessage `chrome.tabs.sendMessage`.
 */
export function createProjectPageChatService({ projectService, findRecordByUrl, sendTabMessage }) {
  // Re-resolving through the project view keeps callers to tabs of that group.
  async function requireProjectTab(projectId, tabId) {
    const view = await projectService.getProjectView(projectId);
    const tab = view.tabs.find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error('tab is not in this project');
    return tab;
  }

  async function findRecord(url) {
    const exact = await findRecordByUrl(url);
    if (exact) return exact;
    const canonical = canonicalPageUrl(url);
    return canonical && canonical !== url ? findRecordByUrl(canonical) : null;
  }

  return {
    /**
     * @param {string} projectId
     * @param {number} tabId
     * @returns {Promise<
     *   | {kind: 'record', key: string, url: string, sentences: string[], topics: object[], contentRevision?: string}
     *   | {kind: 'page', key: string, url: string}
     *   | {kind: 'unsupported', url: string, reason: string}
     * >}
     */
    async getPageChat(projectId, tabId) {
      const tab = await requireProjectTab(projectId, tabId);
      const url = tab.url || '';
      const key = pageChatKey(url);
      if (!READABLE_URL.test(url) || !key) {
        return { kind: 'unsupported', url, reason: UNREADABLE_MESSAGE };
      }
      const record = await findRecord(url);
      if (record?.key) {
        return {
          kind: 'record',
          key: record.key,
          url,
          sentences: Array.isArray(record.sentences) ? record.sentences : [],
          topics: Array.isArray(record.topics) ? record.topics : [],
          ...(typeof record.contentRevision === 'string' && record.contentRevision
            ? { contentRevision: record.contentRevision }
            : {}),
        };
      }
      return { kind: 'page', key, url: canonicalPageUrl(url) };
    },

    /**
     * Reads the tab's rendered text through its content script and splits it
     * into the one-based sentences chat cites.
     * @param {string} projectId
     * @param {number} tabId
     * @returns {Promise<{sentences: string[], truncated: boolean}>}
     */
    async capturePageText(projectId, tabId) {
      const tab = await requireProjectTab(projectId, tabId);
      if (!READABLE_URL.test(tab.url || '')) throw new Error(UNREADABLE_MESSAGE);
      let response;
      try {
        response = await sendTabMessage(tabId, { action: 'capturePageText' });
      } catch {
        throw new Error(UNREACHABLE_MESSAGE);
      }
      if (response?.status !== 'ok' || typeof response.text !== 'string') {
        throw new Error(response?.error || UNREACHABLE_MESSAGE);
      }
      const raw = response.text;
      const text = normalizeCapturedText(raw.slice(0, MAX_PAGE_TEXT_CHARS));
      const sentences = splitSentences(text).map((sentence) => sentence.text);
      if (!sentences.length) throw new Error('No readable text was found on this page.');
      return { sentences, truncated: raw.length > MAX_PAGE_TEXT_CHARS };
    },
  };
}
