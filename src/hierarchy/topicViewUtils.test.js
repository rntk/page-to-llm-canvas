import { describe, it, expect } from 'vitest';
import { normalizeTopicPath, spacedTopicPath, buildSummaryLookup } from './topicViewUtils.js';

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
// buildSummaryLookup
// ---------------------------------------------------------------------------
describe('buildSummaryLookup', () => {
  it('returns an empty map when the index is null', () => {
    const lookup = buildSummaryLookup(null);
    expect(lookup.size).toBe(0);
  });

  it('ignores a non-object index', () => {
    const lookup = buildSummaryLookup('invalid');
    expect(lookup.size).toBe(0);
  });

  it('builds a lookup from topicSummaryIndex', () => {
    const index = { 'Sci>Bio': { runs: [{ text: 'Biology notes' }] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.get('Sci>Bio')).toBe('Biology notes');
  });

  it('concatenates per-run text from a runs-shaped index entry', () => {
    const index = {
      'Sci>Bio': { runs: [{ text: 'Cells.' }, { text: 'Genes.' }] },
    };
    const lookup = buildSummaryLookup(index);
    expect(lookup.get('Sci>Bio')).toBe('Cells. Genes.');
  });

  it('normalises a display-form index key to the canonical lookup key', () => {
    const index = { 'Tech > AI': { runs: [{ text: 'AI summary' }] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.get('Tech>AI')).toBe('AI summary');
    expect(lookup.get('Tech > AI')).toBeUndefined();
  });

  it('skips entries with empty summary text', () => {
    const index = { 'Tech>AI': { runs: [] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.has('Tech>AI')).toBe(false);
  });

  it('skips entries with empty path', () => {
    const index = { '': { runs: [{ text: 'some text' }] } };
    const lookup = buildSummaryLookup(index);
    expect(lookup.has('')).toBe(false);
  });
});
