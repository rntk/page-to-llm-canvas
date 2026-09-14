import { describe, expect, it } from 'vitest';
import {
  RAIL_MODES,
  normalizeRailMode,
  resolveRailLevel,
  createRailState,
} from './railState.js';

describe('railState', () => {
  describe('RAIL_MODES', () => {
    it('defines value and label pairs for topics, summaries, and chat modes', () => {
      expect(RAIL_MODES).toEqual([
        ['topics', 'Topics'],
        ['summaries', 'Summaries'],
        ['chat', 'Chat'],
      ]);
    });
  });

  describe('normalizeRailMode', () => {
    it('returns topics for topics', () => {
      expect(normalizeRailMode('topics')).toBe('topics');
    });

    it('returns summaries for summaries', () => {
      expect(normalizeRailMode('summaries')).toBe('summaries');
    });

    it('returns chat for chat', () => {
      expect(normalizeRailMode('chat')).toBe('chat');
    });

    it('defaults to topics for unknown or missing modes', () => {
      expect(normalizeRailMode()).toBe('topics');
      expect(normalizeRailMode(null)).toBe('topics');
      expect(normalizeRailMode('unknown')).toBe('topics');
      expect(normalizeRailMode('')).toBe('topics');
      expect(normalizeRailMode('canvas')).toBe('topics');
    });
  });

  describe('resolveRailLevel', () => {
    it('extracts number level from options', () => {
      expect(resolveRailLevel({ level: 2 })).toBe(2);
      expect(resolveRailLevel({ level: 0 })).toBe(0);
    });

    it('defaults to 0 for missing, null, or invalid options', () => {
      expect(resolveRailLevel()).toBe(0);
      expect(resolveRailLevel(null)).toBe(0);
      expect(resolveRailLevel({})).toBe(0);
      expect(resolveRailLevel({ level: '1' })).toBe(0);
      expect(resolveRailLevel({ level: null })).toBe(0);
    });
  });

  describe('createRailState', () => {
    it('initializes default state when called without arguments', () => {
      expect(createRailState()).toEqual({
        mode: 'topics',
        selectedLevel: 0,
      });
    });

    it('normalizes mode and resolves level', () => {
      expect(createRailState('summaries', { level: 3 })).toEqual({
        mode: 'summaries',
        selectedLevel: 3,
      });
      expect(createRailState('chat', { level: 1 })).toEqual({
        mode: 'chat',
        selectedLevel: 1,
      });
      expect(createRailState('invalid', { level: 'bad' })).toEqual({
        mode: 'topics',
        selectedLevel: 0,
      });
    });
  });
});
