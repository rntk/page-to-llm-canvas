import { describe, it, expect } from 'vitest';
import {
  getYouTubeRailActiveCardIdFromNormalized,
  getYouTubeRailCardBodyText,
  getYouTubeRailNextActiveIdFromNormalized,
  normalizeYouTubeRailCard,
  normalizeYouTubeRailCards,
} from './viewModel.js';

describe('normalizeYouTubeRailCard', () => {
  it('returns null for non-object input', () => {
    expect(normalizeYouTubeRailCard(null)).toBeNull();
    expect(normalizeYouTubeRailCard('card')).toBeNull();
  });

  it('copies card fields and clones sentence arrays', () => {
    const sentences = [3, 1, 2];
    const card = {
      id: 'card-1',
      name: 'Card 1',
      path: 'Topic > Card 1',
      text: ' summary ',
      accent: 'red',
      seconds: 30,
      sentences,
    };

    const normalized = normalizeYouTubeRailCard(card);

    expect(normalized).toEqual({
      ...card,
      sentences: [3, 1, 2],
    });
    expect(normalized.sentences).not.toBe(sentences);
  });
});

describe('normalizeYouTubeRailCards', () => {
  it('filters invalid cards and keeps valid ones in input order', () => {
    const cards = [
      { id: 'a', seconds: 10, sentences: [1] },
      { id: '', seconds: 20 },
      { id: 'c', seconds: Number.NaN },
      { id: 'd', seconds: 30, sentences: [2, 3] },
    ];

    expect(normalizeYouTubeRailCards(cards).map((card) => card.id)).toEqual(['a', 'd']);
  });
});

describe('getYouTubeRailActiveCardIdFromNormalized', () => {
  const cards = [
    { id: 'intro', seconds: 0 },
    { id: 'middle', seconds: 30 },
    { id: 'outro', seconds: 120 },
  ];

  it('resolves active ids from already normalized cards without cloning them again', () => {
    const normalizedCards = normalizeYouTubeRailCards(cards);
    expect(getYouTubeRailActiveCardIdFromNormalized(normalizedCards, 45)).toBe('middle');
    expect(normalizedCards.map((card) => card.id)).toEqual(['intro', 'middle', 'outro']);
  });

  it('selects the card at the current timestamp boundary', () => {
    const normalizedCards = normalizeYouTubeRailCards(cards);
    expect(getYouTubeRailActiveCardIdFromNormalized(normalizedCards, 119)).toBe('middle');
    expect(getYouTubeRailActiveCardIdFromNormalized(normalizedCards, 120)).toBe('outro');
  });

  it('clamps non-finite time and returns null for no cards', () => {
    expect(getYouTubeRailActiveCardIdFromNormalized(normalizeYouTubeRailCards(cards), NaN)).toBe(
      'intro',
    );
    expect(getYouTubeRailActiveCardIdFromNormalized([], 100)).toBeNull();
  });
});

describe('getYouTubeRailNextActiveIdFromNormalized', () => {
  const cards = [
    { id: 'intro', seconds: 0 },
    { id: 'middle', seconds: 30 },
    { id: 'outro', seconds: 120 },
  ];

  it('resolves next active ids from already normalized cards', () => {
    const normalizedCards = normalizeYouTubeRailCards(cards);
    expect(getYouTubeRailNextActiveIdFromNormalized(normalizedCards, 45, 'intro')).toBe('middle');
    expect(getYouTubeRailNextActiveIdFromNormalized(normalizedCards, 45, 'middle')).toBe('middle');
  });
});

describe('getYouTubeRailCardBodyText', () => {
  it('returns summary text or a fallback', () => {
    expect(getYouTubeRailCardBodyText({ text: '' })).toBe('(no summary)');
    expect(getYouTubeRailCardBodyText({ text: 'details' })).toBe('details');
  });
});
