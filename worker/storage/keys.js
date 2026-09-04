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

// Guards the `:` separator that `chatDocumentStorageKey` composes with: a
// chatId containing a colon could otherwise forge a different record's key.
// Shared by the storage layer and the message-handler validation so the two
// cannot drift apart.
export function isSafeChatId(value) {
  return typeof value === 'string' && !!value && !value.includes(':');
}
