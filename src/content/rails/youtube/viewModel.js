import { findActiveCardIndex } from './sync.js';

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

// Start seconds in card order. Split out so the poll loop can build it once
// per card-list change instead of re-mapping the cards on every tick.
export function getYouTubeRailCardStarts(normalizedCards) {
  return normalizedCards.map((card) => card.seconds);
}

export function getYouTubeRailActiveCardIdFromNormalized(normalizedCards, currentTime, starts) {
  const index = findActiveCardIndex(
    starts || getYouTubeRailCardStarts(normalizedCards),
    currentTime,
  );
  return index >= 0 ? (normalizedCards[index]?.id ?? null) : null;
}

export function getYouTubeRailNextActiveIdFromNormalized(
  normalizedCards,
  currentTime,
  previousActiveId,
  starts,
) {
  const nextActiveId = getYouTubeRailActiveCardIdFromNormalized(
    normalizedCards,
    currentTime,
    starts,
  );
  return nextActiveId === previousActiveId ? previousActiveId : nextActiveId;
}

export function getYouTubeRailCardBodyText(card) {
  return card && typeof card.text === 'string' && card.text ? card.text : '(no summary)';
}
