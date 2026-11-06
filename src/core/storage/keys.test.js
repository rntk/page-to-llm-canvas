import { describe, expect, it } from 'vitest';
import {
  chatDocumentStorageKey,
  chatIndexStorageKey,
  canonicalPageUrl,
  isPageChatKey,
  pageChatKey,
  recordContentStorageKey,
  recordDiagnosticsStorageKey,
  recordMetaStorageKey,
  recordSourceSummaryUnitStorageKey,
  recordSummaryLeafStorageKey,
  recordSummaryOutputStorageKey,
  recordTopicRangeCheckpointStorageKey,
} from './keys.js';

describe('storage key helpers', () => {
  it('uses stable namespaces and suffixes for record storage', () => {
    expect(recordMetaStorageKey('article-1')).toBe('pagetollm:rec:article-1:meta');
    expect(recordContentStorageKey('article-1')).toBe('pagetollm:rec:article-1:content');
    expect(recordSummaryOutputStorageKey('article-1')).toBe(
      'pagetollm:rec:article-1:summary-output',
    );
    expect(recordTopicRangeCheckpointStorageKey('article-1')).toBe(
      'pagetollm:rec:article-1:topic-range-work',
    );
    expect(recordDiagnosticsStorageKey('article-1')).toBe('pagetollm:rec:article-1:diagnostics');
    expect(recordSummaryLeafStorageKey('article-1', 'A>B')).toBe(
      'pagetollm:rec:article-1:summary-leaf:A%3EB',
    );
    expect(recordSourceSummaryUnitStorageKey('article-1', '{"unit":1}')).toBe(
      'pagetollm:rec:article-1:summary-unit:%7B%22unit%22%3A1%7D',
    );
  });

  it('uses the article key for chat indexes and both keys for chat documents', () => {
    expect(chatIndexStorageKey('article-1')).toBe('pagetollm:chats:article-1:index');
    expect(chatDocumentStorageKey('article-1', 'chat-7')).toBe('pagetollm:chats:article-1:chat-7');
  });

  it('encodes imported record keys as a single unambiguous segment', () => {
    expect(recordMetaStorageKey('a:b')).toBe('pagetollm:rec:a%3Ab:meta');
    expect(recordMetaStorageKey('a%3Ab')).toBe('pagetollm:rec:a%253Ab:meta');
    expect(recordSummaryLeafStorageKey('a:summary-leaf:x', 'Topic')).toBe(
      'pagetollm:rec:a%3Asummary-leaf%3Ax:summary-leaf:Topic',
    );
  });
});

describe('page chat keys', () => {
  it('anchors page chats to the URL without its fragment', () => {
    expect(canonicalPageUrl('https://a.test/p?q=1#top')).toBe('https://a.test/p?q=1');
    expect(pageChatKey('https://a.test/p#x')).toBe(pageChatKey('https://a.test/p#y'));
    expect(pageChatKey('https://a.test/p')).not.toBe(pageChatKey('https://a.test/q'));
    expect(isPageChatKey(pageChatKey('https://a.test/p'))).toBe(true);
    expect(isPageChatKey('rec_123')).toBe(false);
  });

  it('rejects unusable URLs', () => {
    expect(canonicalPageUrl('not a url')).toBe('');
    expect(pageChatKey('')).toBe('');
    expect(pageChatKey(undefined)).toBe('');
  });
});
