/**
 * Distinct numbers of an iterable, in ascending order.
 * @param {Iterable<number>} values
 * @returns {number[]}
 */
export function sortedUnique(values) {
  return [...new Set(values)].sort((a, b) => a - b);
}
