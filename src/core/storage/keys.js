// Realm-neutral key helpers shared by the record and chat repositories. Keep
// this module dependency-free so repository dependency direction stays acyclic.

// Record keys may come from imported files and therefore cannot be assumed to
// exclude `:`, the separator used by every physical storage namespace. Encoding
// the segment keeps keys such as `a` and `a:b` in disjoint namespaces.
export function encodeRecordStorageSegment(key) {
  return encodeURIComponent(key);
}

export function decodeRecordStorageSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

export function recordStoragePrefix(key) {
  return `pagetollm:rec:${encodeRecordStorageSegment(key)}:`;
}

export function recordMetaStorageKey(key) {
  return `${recordStoragePrefix(key)}meta`;
}

export function recordContentStorageKey(key) {
  return `${recordStoragePrefix(key)}content`;
}

export function recordSummaryOutputStorageKey(key) {
  return `${recordStoragePrefix(key)}summary-output`;
}

export function recordTopicRangeCheckpointStorageKey(key) {
  return `${recordStoragePrefix(key)}topic-range-work`;
}

export function recordDiagnosticsStorageKey(key) {
  return `${recordStoragePrefix(key)}diagnostics`;
}

export function recordSummaryLeafStoragePrefix(key) {
  return `${recordStoragePrefix(key)}summary-leaf:`;
}

export function recordSummaryLeafStorageKey(key, topicPath) {
  return `${recordSummaryLeafStoragePrefix(key)}${encodeURIComponent(topicPath)}`;
}

export function recordSourceSummaryUnitStoragePrefix(key) {
  return `${recordStoragePrefix(key)}summary-unit:`;
}

export function recordSourceSummaryUnitStorageKey(key, unitId) {
  return `${recordSourceSummaryUnitStoragePrefix(key)}${encodeURIComponent(unitId)}`;
}

export function chatIndexStorageKey(key) {
  return `pagetollm:chats:${key}:index`;
}

export function chatDocumentStorageKey(key, chatId) {
  return `pagetollm:chats:${key}:${chatId}`;
}

// Chats about a page that has no saved record (project canvas per-page chat)
// live under a URL-derived key in the same chat namespace. The prefix keeps
// them apart from record keys, which are generated ids.
export const PAGE_CHAT_KEY_PREFIX = 'page:';

/**
 * The URL a page chat is anchored to: the fragment only scrolls the same
 * document, so `#a` and `#b` share one history.
 * @param {string} url
 * @returns {string} The URL without its fragment, or '' when unparseable.
 */
export function canonicalPageUrl(url) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const parsed = new URL(url);
    parsed.hash = '';
    return parsed.href;
  } catch {
    return '';
  }
}

/**
 * @param {string} url
 * @returns {string} The page chat key, or '' when the URL is unusable.
 */
export function pageChatKey(url) {
  const canonical = canonicalPageUrl(url);
  return canonical ? `${PAGE_CHAT_KEY_PREFIX}${canonical}` : '';
}

export function isPageChatKey(key) {
  return typeof key === 'string' && key.startsWith(PAGE_CHAT_KEY_PREFIX);
}

// Chats about a project excerpt (a passage selected on a page and opened on the
// project canvas) live under the excerpt's id, apart from record and page keys.
export const EXCERPT_CHAT_KEY_PREFIX = 'excerpt:';

/**
 * @param {string} excerptId
 * @returns {string} The excerpt chat key, or '' for an empty id.
 */
export function excerptChatKey(excerptId) {
  return typeof excerptId === 'string' && excerptId ? `${EXCERPT_CHAT_KEY_PREFIX}${excerptId}` : '';
}

export function isExcerptChatKey(key) {
  return typeof key === 'string' && key.startsWith(EXCERPT_CHAT_KEY_PREFIX);
}

/**
 * Chat keys no record owns (page and excerpt chats). Their source is not a
 * record's sentences, so they share one fixed content revision.
 * @param {string} key
 */
export function isDetachedChatKey(key) {
  return isPageChatKey(key) || isExcerptChatKey(key);
}

// Guards the `:` separator that `chatDocumentStorageKey` composes with: a
// chatId containing a colon could otherwise forge a different record's key.
// Shared by the storage layer and the message-handler validation so the two
// cannot drift apart.
export function isSafeChatId(value) {
  return typeof value === 'string' && !!value && !value.includes(':');
}

// One document holding every project (see src/core/projects/). Projects are few
// and small, so a single key keeps rebinding a single read-modify-write.
export const PROJECTS_STORAGE_KEY = 'pagetollm:projects';

// One document holding every project excerpt (see src/core/projects/excerpts.js).
export const PROJECT_EXCERPTS_STORAGE_KEY = 'pagetollm:project-excerpts';
