import { describe, expect, it } from 'vitest';
import { buildProjectChatPages, UNREADABLE_PAGE_REASON } from './projectChatPages.js';

describe('buildProjectChatPages', () => {
  it('returns nothing without input', () => {
    expect(buildProjectChatPages()).toEqual({ pages: [], unreadablePages: [] });
  });

  it('unions tabs and saved pages, deduped by canonical URL, numbered in URL order', () => {
    const { pages } = buildProjectChatPages({
      tabs: [
        { id: 1, title: 'Zed', url: 'https://z.test/page' },
        { id: 2, title: 'Alpha tab', url: 'https://a.test/x#section' },
        { id: 3, title: '', url: 'file:///notes.html' },
      ],
      savedPages: [
        { key: 'k', title: 'Alpha saved', url: 'https://a.test/x' },
        { key: 'm', title: 'Mid', url: 'https://m.test/' },
      ],
    });
    expect(pages).toEqual([
      { page: 1, title: 'file:///notes.html', url: 'file:///notes.html' },
      { page: 2, title: 'Alpha tab', url: 'https://a.test/x' },
      { page: 3, title: 'Mid', url: 'https://m.test/' },
      { page: 4, title: 'Zed', url: 'https://z.test/page' },
    ]);
  });

  it('numbers pages the same whatever the tab order', () => {
    const a = { title: 'A', url: 'https://a.test/' };
    const b = { title: 'B', url: 'https://b.test/' };
    expect(buildProjectChatPages({ tabs: [a, b] })).toEqual(
      buildProjectChatPages({ tabs: [b, a] }),
    );
  });

  it('lists tabs that are not http(s) or file as unreadable, without numbers', () => {
    const { pages, unreadablePages } = buildProjectChatPages({
      tabs: [
        { title: 'Settings', url: 'chrome://settings' },
        { title: 'Docs', url: 'https://d.test/' },
        { title: 'Loading', url: '' },
        { title: 'Ext', url: 'chrome-extension://abc/page.html' },
      ],
    });
    expect(pages).toEqual([{ page: 1, title: 'Docs', url: 'https://d.test/' }]);
    expect(unreadablePages).toEqual([
      { title: 'Ext', url: 'chrome-extension://abc/page.html', reason: UNREADABLE_PAGE_REASON },
      { title: 'Settings', url: 'chrome://settings', reason: UNREADABLE_PAGE_REASON },
    ]);
  });
});
