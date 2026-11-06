// Chrome tab group color names mapped to chip colors.

export const GROUP_COLORS = Object.freeze({
  grey: '#8a8f98',
  blue: '#3b78e7',
  red: '#d93025',
  yellow: '#f2b600',
  green: '#1e8e3e',
  pink: '#e6559e',
  purple: '#8e4ec6',
  cyan: '#12a4b8',
  orange: '#f07b21',
});

/**
 * @param {string|undefined} name Chrome tab group color name.
 * @returns {string} Hex color; grey for unknown names.
 */
export function groupColorHex(name) {
  return GROUP_COLORS[name] || GROUP_COLORS.grey;
}
