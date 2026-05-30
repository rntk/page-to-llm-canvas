import { describe, it, expect } from 'vitest';
import {
  getHierarchyTopicAccentColor,
  getHierarchyTopicHighlightColor,
  getTopicAccentColor,
} from './topicColorUtils.js';

describe('getHierarchyTopicAccentColor', () => {
  it('returns an hsl() color string', () => {
    const result = getHierarchyTopicAccentColor('Tech');
    expect(result).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });

  it('returns the same color for topics sharing the same root', () => {
    const a = getHierarchyTopicAccentColor('Tech > AI');
    const b = getHierarchyTopicAccentColor('Tech > Web');
    expect(a).toBe(b);
  });

  it('returns different colors for different roots', () => {
    const a = getHierarchyTopicAccentColor('Tech');
    const b = getHierarchyTopicAccentColor('Science');
    expect(a).not.toBe(b);
  });

  it('adjusts saturation and lightness based on depth', () => {
    const shallow = getHierarchyTopicAccentColor('Tech', 0);
    const deep = getHierarchyTopicAccentColor('Tech', 4);
    expect(shallow).not.toBe(deep);
  });

  it('handles null topic name', () => {
    const result = getHierarchyTopicAccentColor(null);
    expect(result).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });

  it('handles empty string topic name', () => {
    const result = getHierarchyTopicAccentColor('');
    expect(result).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
});

describe('getHierarchyTopicHighlightColor', () => {
  it('returns an hsl() color string', () => {
    const result = getHierarchyTopicHighlightColor('Tech');
    expect(result).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });

  it('shares hue with accent color for same root', () => {
    const accent = getHierarchyTopicAccentColor('Tech');
    const highlight = getHierarchyTopicHighlightColor('Tech');
    const accentHue = accent.match(/hsl\((\d+)/)[1];
    const highlightHue = highlight.match(/hsl\((\d+)/)[1];
    expect(accentHue).toBe(highlightHue);
  });

  it('has higher lightness than accent color', () => {
    const accent = getHierarchyTopicAccentColor('Tech', 0);
    const highlight = getHierarchyTopicHighlightColor('Tech', 0);
    const accentL = Number(accent.match(/, (\d+)%\)$/)[1]);
    const highlightL = Number(highlight.match(/, (\d+)%\)$/)[1]);
    expect(highlightL).toBeGreaterThan(accentL);
  });

  it('adjusts based on explicit depth parameter', () => {
    const shallow = getHierarchyTopicHighlightColor('Tech', 0);
    const deep = getHierarchyTopicHighlightColor('Tech', 5);
    expect(shallow).not.toBe(deep);
  });
});

describe('getTopicAccentColor', () => {
  it('returns an hsl() color string', () => {
    const result = getTopicAccentColor('Tech');
    expect(result).toMatch(/^hsl\(\d+, 42%, 46%\)$/);
  });

  it('returns different hues for different topic names', () => {
    const a = getTopicAccentColor('Alpha');
    const b = getTopicAccentColor('Beta');
    expect(a).not.toBe(b);
  });

  it('returns the same color for the same input', () => {
    expect(getTopicAccentColor('Tech')).toBe(getTopicAccentColor('Tech'));
  });
});
