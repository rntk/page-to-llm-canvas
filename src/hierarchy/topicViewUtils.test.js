import { describe, it, expect } from 'vitest';
import {
  normalizeTopicPath,
  spacedTopicPath,
  getSummaryText,
  buildSummaryLookup,
} from './topicViewUtils.js';

// ---------------------------------------------------------------------------
// normalizeTopicPath
// ---------------------------------------------------------------------------
describe('normalizeTopicPath', () => {
  it('joins parts with > and trims whitespace', () => {
    expect(normalizeTopicPath('Tech > AI > Models')).toBe('Tech>AI>Models');
  });

  it('handles a path with no separator', () => {
    expect(normalizeTopicPath('Tech')).toBe('Tech');
  });

  it('filters out empty segments from extra separators', () => {
    expect(normalizeTopicPath('>Tech>>AI>')).toBe('Tech>AI');
  });

  it('returns empty string for null or undefined', () => {
    expect(normalizeTopicPath(null)).toBe('');
    expect(normalizeTopicPath(undefined)).toBe('');
    expect(normalizeTopicPath('')).toBe('');
  });

  it('strips > from the title-safe representation', () => {
    // The .replace(/>/g, " ") pattern in TopicHierarchyView renders
    // normalised paths without > in title attributes.
    const normalized = normalizeTopicPath('Tech>AI>Models');
    expect(normalized.replace(/>/g, ' ')).toBe('Tech AI Models');
  });
});

// ---------------------------------------------------------------------------
// spacedTopicPath
// ---------------------------------------------------------------------------
describe('spacedTopicPath', () => {
  it("formats a path with ' > ' separator", () => {
    expect(spacedTopicPath('Tech>AI>Models')).toBe('Tech > AI > Models');
  });

  it('normalises input before formatting', () => {
    expect(spacedTopicPath('Tech > AI > Models')).toBe('Tech > AI > Models');
  });

  it('handles a single segment', () => {
    expect(spacedTopicPath('Tech')).toBe('Tech');
  });

  it('returns empty string for empty input', () => {
    expect(spacedTopicPath('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getSummaryText
// ---------------------------------------------------------------------------
describe('getSummaryText', () => {
  it('returns empty string for falsy input', () => {
    expect(getSummaryText(null)).toBe('');
    expect(getSummaryText(undefined)).toBe('');
    expect(getSummaryText('')).toBe('');
  });

  it('trims and returns a string summary', () => {
    expect(getSummaryText('  hello  ')).toBe('hello');
  });

  it('returns empty string for a non-string, non-object type', () => {
    expect(getSummaryText(42)).toBe('');
  });

  it('combines text and bullets from an object summary', () => {
    const summary = { text: 'Intro', bullets: ['Point A', 'Point B'] };
    expect(getSummaryText(summary)).toBe('Intro Point A Point B');
  });

  it('handles object with only text', () => {
    expect(getSummaryText({ text: 'Just text' })).toBe('Just text');
  });

  it('handles object with only bullets', () => {
    expect(getSummaryText({ bullets: ['B1', 'B2'] })).toBe('B1 B2');
  });

  it('filters blank bullets from an object summary', () => {
    const summary = { text: 'Main', bullets: ['  ', 'Valid', ''] };
    expect(getSummaryText(summary)).toBe('Main Valid');
  });

  it('returns empty string for an empty object', () => {
    expect(getSummaryText({})).toBe('');
  });

  it('returns empty string for a function with text property because it is not an object', () => {
    const func = () => {};
    func.text = 'hello';
    expect(getSummaryText(func)).toBe('');
  });

  it('trims whitespace from summary.text', () => {
    const summary = { text: '  Intro  ' };
    expect(getSummaryText(summary)).toBe('Intro');
  });

  it('ignores non-string bullets in an object summary', () => {
    const summary = { text: 'Main', bullets: [42, null, 'Valid'] };
    expect(getSummaryText(summary)).toBe('Main Valid');
  });

  it('trims whitespace from bullets', () => {
    const summary = { bullets: ['  Point A  '] };
    expect(getSummaryText(summary)).toBe('Point A');
  });

  it('concatenates per-run text for a runs summary', () => {
    const summary = {
      runs: [
        { sentences: [1, 2], text: 'First occurrence.' },
        { sentences: [9], text: 'Second occurrence.' },
      ],
    };
    expect(getSummaryText(summary)).toBe('First occurrence. Second occurrence.');
  });

  it('skips blank and non-string run text when concatenating', () => {
    const summary = {
      runs: [{ text: '  ' }, { text: 'Kept.' }, { text: 42 }, {}],
    };
    expect(getSummaryText(summary)).toBe('Kept.');
  });

  it('returns empty string for a summary whose runs are all empty', () => {
    expect(getSummaryText({ runs: [] })).toBe('');
    expect(getSummaryText({ runs: [{ text: '' }] })).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildSummaryLookup
// ---------------------------------------------------------------------------
describe('buildSummaryLookup', () => {
  it('returns an empty map when both arguments are null', () => {
    const lookup = buildSummaryLookup(null, null);
    expect(lookup.size).toBe(0);
  });

  it('ignores non-object arguments when building lookup', () => {
    const lookup = buildSummaryLookup('invalid', 'also-invalid');
    expect(lookup.size).toBe(0);
  });

  it('builds a lookup from topicSummaries', () => {
    const summaries = { 'Tech>AI': 'AI summary' };
    const lookup = buildSummaryLookup(summaries, null);
    expect(lookup.get('Tech>AI')).toBe('AI summary');
  });

  it('adds a spaced variant for each entry', () => {
    const summaries = { 'Tech>AI': 'AI summary' };
    const lookup = buildSummaryLookup(summaries, null);
    expect(lookup.get('Tech > AI')).toBe('AI summary');
  });

  it('builds a lookup from topicSummaryIndex', () => {
    const index = { 'Sci>Bio': 'Biology notes' };
    const lookup = buildSummaryLookup(null, index);
    expect(lookup.get('Sci>Bio')).toBe('Biology notes');
  });

  it('concatenates per-run text from a runs-shaped index entry', () => {
    const index = {
      'Sci>Bio': { runs: [{ text: 'Cells.' }, { text: 'Genes.' }] },
    };
    const lookup = buildSummaryLookup(null, index);
    expect(lookup.get('Sci>Bio')).toBe('Cells. Genes.');
    expect(lookup.get('Sci > Bio')).toBe('Cells. Genes.');
  });

  it('merges both sources; topicSummaryIndex entries overwrite topicSummaries for same path', () => {
    const summaries = { 'Tech>AI': 'from summaries' };
    const index = { 'Tech>AI': 'from index' };
    const lookup = buildSummaryLookup(summaries, index);
    expect(lookup.get('Tech>AI')).toBe('from index');
  });

  it('normalises paths with spaces when building keys', () => {
    const summaries = { 'Tech > AI': 'AI summary' };
    const lookup = buildSummaryLookup(summaries, null);
    // Both normalised (no spaces) and spaced variants should resolve
    expect(lookup.get('Tech>AI')).toBe('AI summary');
    expect(lookup.get('Tech > AI')).toBe('AI summary');
  });

  it('skips entries with empty summary text', () => {
    const summaries = { 'Tech>AI': '' };
    const lookup = buildSummaryLookup(summaries, null);
    expect(lookup.has('Tech>AI')).toBe(false);
  });

  it('skips entries with empty path', () => {
    const summaries = { '': 'some text' };
    const lookup = buildSummaryLookup(summaries, null);
    expect(lookup.has('')).toBe(false);
  });
});
