// Conservative shared estimator for pipeline and chat budgeting.

export const CONSERVATIVE_CHARS_PER_TOKEN = 2;
export const CONSERVATIVE_BYTES_PER_TOKEN = 3;
const ESTIMATOR_SAFETY_FACTOR = 1.1;
// Max UTF-8 bytes per UTF-16 code unit (BMP U+0800–U+FFFF). Astral code points
// are 4 bytes over 2 code units = 2 bytes/unit, so 3 is the per-unit worst case.
export const WORST_CASE_BYTES_PER_CODE_UNIT = 3;

const encoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;

export function utf8ByteLength(text) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!text) return 0;
  if (encoder) return encoder.encode(text).length;
  // Fallback for environments without TextEncoder (not expected in extension).
  // eslint-disable-next-line no-undef
  if (typeof Buffer !== 'undefined' && typeof Buffer.byteLength === 'function') {
    // eslint-disable-next-line no-undef
    return Buffer.byteLength(text, 'utf8');
  }
  return text.length * 3;
}

export function estimateTokens(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('text must be a string');
  if (!text) return 0;
  const {
    safetyFactor = ESTIMATOR_SAFETY_FACTOR,
    charsPerToken = CONSERVATIVE_CHARS_PER_TOKEN,
    bytesPerToken = CONSERVATIVE_BYTES_PER_TOKEN,
    tokenizer = null,
  } = options;

  if (typeof tokenizer === 'function') {
    try {
      const tok = tokenizer(text);
      if (Number.isFinite(tok) && tok >= 0) {
        return Math.ceil(tok * safetyFactor);
      }
    } catch {
      // fall through to heuristic
    }
  }

  const charTokens = Math.ceil(text.length / charsPerToken);
  const byteTokens = Math.ceil(utf8ByteLength(text) / bytesPerToken);
  const base = Math.max(charTokens, byteTokens);
  return Math.ceil(base * safetyFactor);
}

// Estimate without allocating a string of length charCount.
// bytesPerChar is UTF-8 bytes per code unit for the assumed payload density.
// Defaults to WORST_CASE_BYTES_PER_CODE_UNIT so callers that forget the
// option remain conservative rather than silently underestimating.
export function estimateTokensForCharCount(charCount, options = {}) {
  if (!Number.isFinite(charCount) || charCount < 0) throw new TypeError('charCount must be a non-negative finite number');
  if (charCount === 0) return 0;
  const {
    safetyFactor = ESTIMATOR_SAFETY_FACTOR,
    charsPerToken = CONSERVATIVE_CHARS_PER_TOKEN,
    bytesPerToken = CONSERVATIVE_BYTES_PER_TOKEN,
    bytesPerChar = WORST_CASE_BYTES_PER_CODE_UNIT,
  } = options;
  const charTokens = Math.ceil(charCount / charsPerToken);
  const byteTokens = Math.ceil((charCount * bytesPerChar) / bytesPerToken);
  const base = Math.max(charTokens, byteTokens);
  return Math.ceil(base * safetyFactor);
}

export function estimateMaxCharsForTokens(tokenBudget, options = {}) {
  const {
    safetyFactor = ESTIMATOR_SAFETY_FACTOR,
    charsPerToken = CONSERVATIVE_CHARS_PER_TOKEN,
    bytesPerToken = CONSERVATIVE_BYTES_PER_TOKEN,
    worstCaseBytesPerChar = WORST_CASE_BYTES_PER_CODE_UNIT,
  } = options;

  if (!Number.isFinite(tokenBudget) || tokenBudget <= 0) {
    throw new RangeError('tokenBudget must be a positive finite number');
  }
  const tokensPerCharChar = (1 / charsPerToken) * safetyFactor;
  const tokensPerCharByte = (worstCaseBytesPerChar / bytesPerToken) * safetyFactor;
  const tokensPerChar = Math.max(tokensPerCharChar, tokensPerCharByte);
  let maxChars = Math.max(1, Math.floor(tokenBudget / tokensPerChar));
  // Adjust for ceil effects so the worst-case payload is guaranteed to fit.
  // Note: for tiny budgets (1–2 tokens) ceil rounding means a single worst-case
  // char (3 bytes → 1 token → ceil 1*1.1 =2) exceeds the budget; maxChars stays
  // at 1 and the guarantee does not hold. This is unreachable from the
  // pipeline (minimum real budget is ~730 tokens) but callers with tiny budgets
  // should expect the invariant to be violated.
  while (
    maxChars > 1 &&
    estimateTokensForCharCount(maxChars, {
      safetyFactor,
      charsPerToken,
      bytesPerToken,
      bytesPerChar: worstCaseBytesPerChar,
    }) > tokenBudget
  ) {
    maxChars--;
  }
  while (
    estimateTokensForCharCount(maxChars + 1, {
      safetyFactor,
      charsPerToken,
      bytesPerToken,
      bytesPerChar: worstCaseBytesPerChar,
    }) <= tokenBudget
  ) {
    maxChars++;
  }
  return maxChars;
}
