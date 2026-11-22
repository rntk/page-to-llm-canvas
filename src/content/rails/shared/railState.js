/** Shared rail state helpers for in-page and YouTube rails. */

import { RAIL_MODE } from '../../../shared/runtime/contracts.js';

export const RAIL_MODES = Object.freeze([
  [RAIL_MODE.TOPICS, 'Topics'],
  [RAIL_MODE.SUMMARIES, 'Summaries'],
  [RAIL_MODE.CHAT, 'Chat'],
]);

export const RAIL_SIDES = Object.freeze(['right', 'left']);

/**
 * Normalize a rail side to 'right' or 'left', defaulting to 'right'.
 *
 * @param {string} [side]
 * @returns {'right'|'left'}
 */
export function normalizeRailSide(side) {
  return RAIL_SIDES.includes(side) ? side : RAIL_SIDES[0];
}

const VALID_MODES = new Set(RAIL_MODES.map(([mode]) => mode));

/**
 * Normalize a rail mode to one in RAIL_MODES, defaulting to 'topics'.
 *
 * @param {string} [mode]
 * @returns {'topics'|'summaries'|'chat'}
 */
export function normalizeRailMode(mode) {
  return VALID_MODES.has(mode) ? mode : RAIL_MODE.TOPICS;
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
