import { describe, it, expect } from 'vitest';
import { splitSentences } from './sentenceSplitter.js';

describe('splitSentences', () => {
  it('returns empty array for empty string', () => {
    expect(splitSentences('')).toEqual([]);
  });

  it('returns empty array for whitespace-only string', () => {
    expect(splitSentences('   \n\t  ')).toEqual([]);
  });

  it('returns empty array for null', () => {
    expect(splitSentences(null)).toEqual([]);
  });

  it('splits on period followed by space and capital letter', () => {
    const result = splitSentences(
      'Hello world this is fine. This is a test sentence here. Goodbye world from me too.',
    );
    expect(result.length).toBe(3);
    expect(result[0].text).toMatch(/Hello world/);
    expect(result[1].text).toMatch(/This is a test/);
    expect(result[2].text).toMatch(/Goodbye world/);
  });

  it('splits on exclamation mark', () => {
    const result = splitSentences('Wow that is really great! That is very wonderful news today!');
    expect(result.length).toBe(2);
  });

  it('splits on question mark', () => {
    const result = splitSentences('What is this thing here? I honestly do not know either.');
    expect(result.length).toBe(2);
  });

  it('does not split on Mr. abbreviation', () => {
    const result = splitSentences(
      'Mr. Smith went to the store yesterday. He bought milk and bread for the whole family.',
    );
    const texts = result.map((s) => s.text);
    const mrSentence = texts.find((t) => t.includes('Mr.'));
    expect(mrSentence).toBeDefined();
    expect(mrSentence).toContain('Smith went to the store yesterday');
    expect(mrSentence).not.toMatch(/^Mr\.\s*$/);
  });

  it('does not split on Dr. abbreviation', () => {
    const result = splitSentences(
      'Dr. Jones arrived at the hospital early. She performed the surgery with great care today.',
    );
    const texts = result.map((s) => s.text);
    const drSentence = texts.find((t) => t.includes('Dr.'));
    expect(drSentence).toBeDefined();
  });

  it('each result has text, start, and end properties', () => {
    const result = splitSentences('First sentence here. Second sentence here too.');
    for (const s of result) {
      expect(s).toHaveProperty('text');
      expect(s).toHaveProperty('start');
      expect(s).toHaveProperty('end');
      expect(typeof s.text).toBe('string');
      expect(typeof s.start).toBe('number');
      expect(typeof s.end).toBe('number');
    }
  });

  it('start and end offsets point into the original text', () => {
    const text = 'First sentence here. Second sentence here too.';
    const result = splitSentences(text);
    for (const s of result) {
      expect(text.slice(s.start, s.end)).toBe(s.text);
    }
  });

  it('handles a single short sentence', () => {
    const result = splitSentences('Hello world.');
    expect(result.length).toBeGreaterThanOrEqual(1);
  });

  it('handles text with closing quotes after terminal punctuation', () => {
    const result = splitSentences(
      'He said "hello" to everyone there. Then he walked away into the sunset glow slowly.',
    );
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('respects custom minSentenceWords option', () => {
    const text = 'Hi. This is a longer sentence with many more words to read. Ok.';
    const result = splitSentences(text, { minSentenceWords: 3 });
    expect(result.length).toBeLessThan(3);
  });

  it('merges short sentences with adjacent ones', () => {
    const text = 'First full sentence right here. Hi. Another full sentence with many words.';
    const result = splitSentences(text, { minSentenceWords: 3 });
    const texts = result.map((s) => s.text);
    const standaloneHi = texts.some((t) => /^\s*Hi\.\s*$/.test(t));
    expect(standaloneHi).toBe(false);
  });

  it('handles a long sentence by splitting at word boundaries', () => {
    const words = Array.from({ length: 40 }, (_, i) => `word${i}`).join(' ');
    const text = `${words}. This is a trailing sentence here.`;
    const result = splitSentences(text, {
      anchorEveryWords: 10,
      longSentenceWordThreshold: 20,
      minSentenceWords: 2,
    });
    expect(result.length).toBeGreaterThan(1);
  });

  it('finishes a long span when remaining words drop below the anchor window', () => {
    const words = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ');
    const result = splitSentences(`${words}.`, {
      anchorEveryWords: 10,
      longSentenceWordThreshold: 20,
      minSentenceWords: 15,
    });
    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].text).toContain('word0');
  });

  it('falls back to the full tail when no whitespace cut is found', () => {
    const head = Array.from({ length: 22 }, (_, i) => `w${i}`).join(' ');
    const tail = Array.from({ length: 8 }, (_, i) => `t${i}`).join('');
    const result = splitSentences(`${head} ${tail}.`, {
      anchorEveryWords: 10,
      longSentenceWordThreshold: 20,
      minSentenceWords: 2,
    });
    expect(result.some((s) => s.text.includes('t0t1'))).toBe(true);
  });
});
