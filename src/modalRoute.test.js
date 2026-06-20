import { describe, expect, it, vi } from 'vitest';
import { parseModalRoute } from './modalRoute.js';

describe('parseModalRoute', () => {
  it('extracts key and view from a query string', () => {
    expect(parseModalRoute('?key=abc&view=hierarchy')).toEqual({ key: 'abc', view: 'hierarchy' });
  });

  it('defaults missing values to empty strings', () => {
    expect(parseModalRoute('?key=abc')).toEqual({ key: 'abc', view: '' });
    expect(parseModalRoute('')).toEqual({ key: '', view: '' });
  });

  it('handles null and undefined', () => {
    expect(parseModalRoute(null)).toEqual({ key: '', view: '' });
    expect(parseModalRoute(undefined)).toEqual({ key: '', view: '' });
  });

  it('handles malformed but URLSearchParams-tolerant input', () => {
    expect(parseModalRoute('key=onlyNoQ')).toEqual({ key: 'onlyNoQ', view: '' });
    expect(parseModalRoute('?foo=bar&key=mykey&view=canvas')).toEqual({
      key: 'mykey',
      view: 'canvas',
    });
  });

  it('returns empty strings for keys with no value', () => {
    expect(parseModalRoute('?key&view')).toEqual({ key: '', view: '' });
  });

  it('returns empty strings when URLSearchParams throws', () => {
    const spy = vi.spyOn(globalThis, 'URLSearchParams').mockImplementation(() => {
      throw new Error('bad query');
    });
    expect(parseModalRoute('?key=abc')).toEqual({ key: '', view: '' });
    spy.mockRestore();
  });
});
