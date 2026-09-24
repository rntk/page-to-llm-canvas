import { describe, it, expect } from 'vitest';
import {
  getHierarchyTopicAccentColor,
  getHierarchyTopicHighlightColor,
  getHierarchyTopicHighlightColorDark,
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
    expect(a).toBe('hsl(48, 52%, 42%)');
    expect(b).toBe('hsl(270, 52%, 42%)');
  });

  it('adjusts saturation and lightness based on depth', () => {
    const shallow = getHierarchyTopicAccentColor('Tech', 0);
    const deep = getHierarchyTopicAccentColor('Tech', 4);
    expect(shallow).toBe('hsl(48, 52%, 42%)');
    expect(deep).toBe('hsl(48, 32%, 62%)');
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
    expect(shallow).toBe('hsl(48, 36%, 94%)');
    expect(deep).toBe('hsl(48, 16%, 84%)');
  });
});

describe('getHierarchyTopicHighlightColorDark', () => {
  it('returns an hsl() color string', () => {
    const result = getHierarchyTopicHighlightColorDark('Tech');
    expect(result).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });

  it('shares hue with the light highlight color for the same root', () => {
    const light = getHierarchyTopicHighlightColor('Tech', 0);
    const dark = getHierarchyTopicHighlightColorDark('Tech', 0);
    expect(dark.match(/hsl\((\d+)/)[1]).toBe(light.match(/hsl\((\d+)/)[1]);
  });

  it('is much darker than the light highlight color', () => {
    const light = Number(getHierarchyTopicHighlightColor('Tech', 0).match(/, (\d+)%\)$/)[1]);
    const dark = Number(getHierarchyTopicHighlightColorDark('Tech', 0).match(/, (\d+)%\)$/)[1]);
    expect(dark).toBeLessThan(light);
    expect(dark).toBeLessThanOrEqual(28);
  });

  it('adjusts based on explicit depth parameter', () => {
    const shallow = getHierarchyTopicHighlightColorDark('Tech', 0);
    const deep = getHierarchyTopicHighlightColorDark('Tech', 5);
    expect(shallow).toBe('hsl(48, 34%, 19%)');
    expect(deep).toBe('hsl(48, 19%, 30%)');
  });

  it('handles null topic name', () => {
    expect(getHierarchyTopicHighlightColorDark(null)).toMatch(/^hsl\(\d+, \d+%, \d+%\)$/);
  });
});
