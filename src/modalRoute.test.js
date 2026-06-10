import { describe, expect, it } from 'vitest';
import { parseModalRoute } from './modalRoute.js';

describe('parseModalRoute', () => {
  it('extracts key and view from a query string', () => {
    expect(parseModalRoute('?key=abc&view=hierarchy')).toEqual({ key: 'abc', view: 'hierarchy' });
  });

  it('defaults missing values to empty strings', () => {
    expect(parseModalRoute('?key=abc')).toEqual({ key: 'abc', view: '' });
    expect(parseModalRoute('')).toEqual({ key: '', view: '' });
  });
});
