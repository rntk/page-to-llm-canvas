import { findActiveCardIndex } from './youtubeRailSync.js';

export function normalizeYouTubeRailCard(card) {
  if (!card || typeof card !== 'object') return null;

  return {
    ...card,
    id: typeof card.id === 'string' ? card.id : '',
    name: typeof card.name === 'string' ? card.name : '',
    path: typeof card.path === 'string' ? card.path : '',
    text: typeof card.text === 'string' ? card.text : '',
    accent: typeof card.accent === 'string' ? card.accent : '',
    seconds: Number(card.seconds),
    sentences: Array.isArray(card.sentences) ? card.sentences.slice() : [],
  };
}

export function normalizeYouTubeRailCards(cards) {
  if (!Array.isArray(cards)) return [];
  return cards
    .map(normalizeYouTubeRailCard)
    .filter((card) => card && card.id && Number.isFinite(card.seconds));
}

export function getYouTubeRailCardSeconds(cards) {
  return normalizeYouTubeRailCards(cards).map((card) => card.seconds);
}

export function getYouTubeRailActiveCardId(cards, currentTime) {
  const normalizedCards = normalizeYouTubeRailCards(cards);
  const starts = normalizedCards.map((card) => card.seconds);
  const index = findActiveCardIndex(starts, currentTime);
  return index >= 0 ? (normalizedCards[index]?.id ?? null) : null;
}

export function getYouTubeRailNextActiveId(cards, currentTime, previousActiveId) {
  const nextActiveId = getYouTubeRailActiveCardId(cards, currentTime);
  return nextActiveId === previousActiveId ? previousActiveId : nextActiveId;
}

export function getYouTubeRailCardBodyText(card, isSummary) {
  if (!isSummary) return '';
  return card && typeof card.text === 'string' && card.text ? card.text : '(no summary)';
}
