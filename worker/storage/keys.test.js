import { describe, expect, it } from 'vitest';
import {
  chatDocumentStorageKey,
  chatIndexStorageKey,
  recordContentStorageKey,
  recordMetaStorageKey,
  recordSummariesStorageKey,
} from './keys.js';

describe('storage key helpers', () => {
  it('uses stable namespaces and suffixes for record storage', () => {
    expect(recordMetaStorageKey('article-1')).toBe('pagetollm:rec:article-1:meta');
    expect(recordContentStorageKey('article-1')).toBe('pagetollm:rec:article-1:content');
    expect(recordSummariesStorageKey('article-1')).toBe('pagetollm:rec:article-1:summaries');
  });

  it('uses the article key for chat indexes and both keys for chat documents', () => {
    expect(chatIndexStorageKey('article-1')).toBe('pagetollm:chats:article-1:index');
    expect(chatDocumentStorageKey('article-1', 'chat-7')).toBe('pagetollm:chats:article-1:chat-7');
  });
});
