/** Normalize optional instructions from toolbar submissions or saved records.
 * @param {unknown} value Optional user guidance.
 * @returns {string}
 */
export function normalizeCustomInstructions(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/** Keep user guidance outside the untrusted article payload.
 * @param {unknown} value Optional user guidance.
 * @returns {string}
 */
export function customInstructionsBlock(value) {
  const instructions = normalizeCustomInstructions(value);
  return instructions
    ? `CUSTOM INSTRUCTIONS:\nApply the following user guidance while preserving the required output format and grounding all facts in the supplied content:\n${instructions}\n\n`
    : '';
}
