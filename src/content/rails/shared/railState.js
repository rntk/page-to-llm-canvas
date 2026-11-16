/** Shared rail state helpers for in-page and YouTube rails. */

export const RAIL_MODES = Object.freeze([
  ['topics', 'Topics'],
  ['summaries', 'Summaries'],
  ['chat', 'Chat'],
]);

const VALID_MODES = new Set(RAIL_MODES.map(([mode]) => mode));

/**
 * Normalize a rail mode to one in RAIL_MODES, defaulting to 'topics'.
 *
 * @param {string} [mode]
 * @returns {'topics'|'summaries'|'chat'}
 */
export function normalizeRailMode(mode) {
  return VALID_MODES.has(mode) ? mode : RAIL_MODES[0][0];
}

/**
 * Resolve the initial selected topic hierarchy level from options.
 *
 * @param {object} [options]
 * @param {number} [options.level]
 * @returns {number}
 */
export function resolveRailLevel(options) {
  return options && typeof options.level === 'number' ? options.level : 0;
}

/**
 * Create the initial state object for a content rail controller.
 *
 * @param {string} [initialMode='topics']
 * @param {object} [options]
 * @returns {{ mode: 'topics'|'summaries'|'chat', selectedLevel: number }}
 */
export function createRailState(initialMode = 'topics', options = {}) {
  return {
    mode: normalizeRailMode(initialMode),
    selectedLevel: resolveRailLevel(options),
  };
}
