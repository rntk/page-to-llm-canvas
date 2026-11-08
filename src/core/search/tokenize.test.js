import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize.js';

describe('tokenize', () => {
  it('lowercases, splits on unicode words and folds diacritics', () => {
    expect(tokenize('Éolienne, WIND-power: 2024! Ünïcode 風力')).toEqual([
      'eolienne',
      'wind',
      'power',
      '2024',
      'unicode',
      '風力',
    ]);
  });
});
