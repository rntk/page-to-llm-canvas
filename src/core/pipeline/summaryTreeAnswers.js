// Parsing of model answers: JSON extraction and typed decision choices.

/**
 * First JSON object in an answer; code fences and chatter are tolerated.
 * @param {unknown} raw Model answer.
 * @returns {object|null}
 */
export function extractObject(raw) {
  const text = String(raw ?? '').replace(/```(?:json)?/giu, '');
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0;
    let inString = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (inString) {
        if (char === '\\') index++;
        else if (char === '"') inString = false;
      } else if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}' && --depth === 0) {
        try {
          const value = JSON.parse(text.slice(start, index + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch (_) {
          /* Not JSON; try the next opening brace. */
        }
        break;
      }
    }
  }
  return null;
}

/**
 * Probability of "yes" for a yes/no choice, or null when absent or malformed.
 * @param {object|null} answers Decision answers by question id.
 * @param {string} name Question id.
 */
export function yesProbability(answers, name) {
  const value = answers?.[name]?.probabilities?.yes;
  return Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/**
 * Chosen option, or null when it is not one of `options`.
 * @param {object|null} answers Decision answers by question id.
 * @param {string} name Question id.
 * @param {string[]} options Allowed options.
 */
export function chosenOption(answers, name, options) {
  const value = answers?.[name]?.choice;
  return typeof value === 'string' && options.includes(value) ? value : null;
}
