import { describe, expect, it } from 'vitest';
import {
  CONSERVATIVE_BYTES_PER_TOKEN,
  CONSERVATIVE_CHARS_PER_TOKEN,
  WORST_CASE_BYTES_PER_CODE_UNIT,
  estimateMaxCharsForTokens,
  estimateTokens,
  estimateTokensForCharCount,
  utf8ByteLength,
} from './tokenEstimator.js';
import { getPipelineTextChunkMaxChars } from '../pipeline/pipelineConfig.js';
import { getArticleChatLimits } from './articleChatLimits.js';
import { ARTICLE_CHAT_MAX_CHUNK_CHARS, ARTICLE_CHAT_MAX_HISTORY_CHARS } from '../settings/articleChatBudget.js';

// Helper: BMP char that is 3 bytes in UTF-8 (U+0800) – worst case per code unit.
const THREE_BYTE_CHAR = '\u0800';

describe('tokenEstimator', () => {
  it('estimates Latin prose conservatively', () => {
    const text = 'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(20);
    const tokens = estimateTokens(text);
    expect(tokens).toBeGreaterThanOrEqual(Math.ceil(text.length / CONSERVATIVE_CHARS_PER_TOKEN));
    expect(utf8ByteLength(text)).toBe(text.length);
  });

  it('estimates CJK text with higher token density than naive 4-chars-per-token', () => {
    const cjk = '漢字かなカナ'.repeat(200);
    const tokens = estimateTokens(cjk);
    expect(tokens).toBeGreaterThan(Math.ceil(cjk.length / 4));
    expect(utf8ByteLength(cjk)).toBe(cjk.length * 3);
    expect(tokens).toBeGreaterThanOrEqual(Math.ceil(utf8ByteLength(cjk) / CONSERVATIVE_BYTES_PER_TOKEN));
  });

  it('estimates Cyrillic with multi-byte awareness', () => {
    const cyrillic = 'Привет мир '.repeat(100);
    expect(estimateTokens(cyrillic)).toBeGreaterThan(Math.ceil(cyrillic.length / 4));
    expect(utf8ByteLength(cyrillic)).toBeGreaterThan(cyrillic.length);
  });

  it('estimates emoji correctly (2 code units, 4 bytes)', () => {
    const emoji = '😀😃😄😁'.repeat(100); // each emoji 2 code units in JS, 4 bytes UTF-8
    expect(utf8ByteLength(emoji)).toBe(emoji.length * 2);
    // Emoji is 2 bytes per code unit, less dense than BMP worst-case (3 bytes/unit)
    const worstBmp = THREE_BYTE_CHAR.repeat(emoji.length);
    expect(estimateTokens(worstBmp)).toBeGreaterThan(estimateTokens(emoji));
  });

  it('worst-case per code unit is 3 bytes (BMP), not 4', () => {
    expect(WORST_CASE_BYTES_PER_CODE_UNIT).toBe(3);
    expect(utf8ByteLength(THREE_BYTE_CHAR)).toBe(3);
    expect(utf8ByteLength('a')).toBe(1);
    expect(utf8ByteLength('😀')).toBe(4);
    // Per code unit: '😀'.length===2, bytes 4 => 2 bytes/unit
    expect(utf8ByteLength('😀') / '😀'.length).toBe(2);
  });

  it('estimates code and minified data conservatively', () => {
    const code = 'function foo(a,b){return a+b;}\n'.repeat(80);
    const minified = '{"a":1,"b":[2,3],"c":{"d":4}}'.repeat(50);
    expect(estimateTokens(code)).toBeGreaterThan(Math.ceil(code.length / 4));
    expect(estimateTokens(minified)).toBeGreaterThan(Math.ceil(minified.length / 4));
  });

  it('estimates JSON-escaped content', () => {
    const json = JSON.stringify({ text: 'a'.repeat(1000), arr: [1, 2, 3] }).repeat(5);
    expect(estimateTokens(json)).toBeGreaterThan(Math.ceil(json.length / 4));
    expect(utf8ByteLength(json)).toBeGreaterThanOrEqual(json.length);
  });

  it('estimateTokensForCharCount matches estimateTokens for known strings without allocation', () => {
    const n = 1024;
    const str = 'a'.repeat(n);
    expect(estimateTokensForCharCount(n, { bytesPerChar: 1 })).toBe(estimateTokens(str));
    const bmpWorst = THREE_BYTE_CHAR.repeat(n);
    expect(estimateTokensForCharCount(n, { bytesPerChar: 3 })).toBe(estimateTokens(bmpWorst));
  });

  it('prefers provider tokenizer when supplied and applies safety factor', () => {
    const text = 'hello world';
    const fakeTokenizer = (t) => t.length / 4;
    expect(estimateTokens(text, { tokenizer: fakeTokenizer, safetyFactor: 1.5 })).toBe(
      Math.ceil((text.length / 4) * 1.5),
    );
    const badTokenizer = () => {
      throw new Error('nope');
    };
    expect(estimateTokens(text, { tokenizer: badTokenizer })).toBe(estimateTokens(text));
  });

  it('inverse: max chars for tokens respects worst-case per code unit', () => {
    const budget = 1024;
    const maxChars = estimateMaxCharsForTokens(budget);
    const worstPayload = THREE_BYTE_CHAR.repeat(maxChars);
    expect(estimateTokens(worstPayload)).toBeLessThanOrEqual(budget);
    expect(estimateTokens(THREE_BYTE_CHAR.repeat(maxChars + 1))).toBeGreaterThan(budget);
    expect(estimateTokens('a'.repeat(maxChars))).toBeLessThanOrEqual(budget);
  });

  it('safety factor increases estimate', () => {
    const text = 'a'.repeat(100);
    expect(estimateTokens(text, { safetyFactor: 1.5 })).toBeGreaterThan(
      estimateTokens(text, { safetyFactor: 1.0 }),
    );
  });

  it('rejects invalid inputs', () => {
    expect(() => estimateTokens(12345)).toThrow(TypeError);
    expect(() => estimateTokens(null)).toThrow(TypeError);
    expect(() => estimateTokensForCharCount(-1)).toThrow(TypeError);
    expect(() => estimateMaxCharsForTokens(0)).toThrow(RangeError);
    expect(() => estimateMaxCharsForTokens(-5)).toThrow(RangeError);
    expect(() => estimateMaxCharsForTokens(NaN)).toThrow(RangeError);
  });
});

describe('budget safety invariants', () => {
  it('chat budgets split pipeline budget', () => {
    for (const windowTokens of [4096, 8192, 16384]) {
      const maxChars = getPipelineTextChunkMaxChars(windowTokens);
      const limits = getArticleChatLimits(windowTokens);
      if (maxChars >= ARTICLE_CHAT_MAX_CHUNK_CHARS) {
        expect(limits.maxChunkChars).toBe(ARTICLE_CHAT_MAX_CHUNK_CHARS);
        expect(limits.maxHistoryChars).toBe(ARTICLE_CHAT_MAX_HISTORY_CHARS);
      } else {
        expect(limits.maxChunkChars + limits.maxHistoryChars).toBeLessThanOrEqual(maxChars);
      }
    }
  });

  it('documents fallback for unknown window', () => {
    expect(getPipelineTextChunkMaxChars(undefined)).toBe(60000);
    expect(getPipelineTextChunkMaxChars(null)).toBe(60000);
    expect(getArticleChatLimits(undefined).maxChunkChars).toBe(ARTICLE_CHAT_MAX_CHUNK_CHARS);
    expect(estimateTokens('a'.repeat(60000))).toBeGreaterThan(0);
  });

  it('large window caps remain stable', () => {
    expect(getPipelineTextChunkMaxChars(1_000_000)).toBe(60000);
    expect(getPipelineTextChunkMaxChars(100_000)).toBeLessThanOrEqual(60000);
    expect(getArticleChatLimits(1_000_000).maxChunkChars).toBe(ARTICLE_CHAT_MAX_CHUNK_CHARS);
  });
});
