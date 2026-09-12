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

  it('short-span merging absorbs the fragment left by an abbreviation', () => {
    const result = splitSentences(
      'Mr. Smith went to the store yesterday. He bought milk and bread for the whole family.',
    );
    expect(result.map(({ text }) => text)).toEqual([
      'Mr. Smith went to the store yesterday.',
      'He bought milk and bread for the whole family.',
    ]);
  });

  it('splits after an abbreviation period when short-span merging is disabled', () => {
    const result = splitSentences('Dr. Smith arrived at noon. Then everyone went inside.', {
      minSentenceWords: 1,
    });
    expect(result.map(({ text }) => text)).toEqual([
      'Dr.',
      'Smith arrived at noon.',
      'Then everyone went inside.',
    ]);
  });

  it('does not split before a lowercase continuation', () => {
    const text = 'This clause ends here. but the thought continues after it.';
    expect(splitSentences(text, { minSentenceWords: 1 })).toEqual([
      { text, start: 0, end: text.length },
    ]);
  });

  it('trims both ends while preserving exact source offsets', () => {
    const text = '  This sentence has padding.  ';
    expect(splitSentences(text, { minSentenceWords: 1 })).toEqual([
      {
        text: 'This sentence has padding.',
        start: 2,
        end: text.length - 2,
      },
    ]);
  });

  it('splits Cyrillic text on a terminal boundary', () => {
    const result = splitSentences('Это первое предложение здесь. Это второе предложение тоже.');
    expect(result.map(({ text }) => text)).toEqual([
      'Это первое предложение здесь.',
      'Это второе предложение тоже.',
    ]);
  });

  it('splits Greek text on a terminal boundary', () => {
    const result = splitSentences('Αυτή είναι η πρώτη πρόταση. Αυτή είναι η δεύτερη πρόταση.');
    expect(result).toHaveLength(2);
  });

  it('splits Arabic text after a full-width question mark', () => {
    const result = splitSentences('هذه هي الجملة الأولى هنا؟ هذه هي الجملة الثانية هنا.');
    expect(result.map(({ text }) => text)).toEqual([
      'هذه هي الجملة الأولى هنا؟',
      'هذه هي الجملة الثانية هنا.',
    ]);
  });

  it('splits Hebrew text on an ASCII period', () => {
    const result = splitSentences('זהו המשפט הראשון כאן. זהו המשפט השני כאן.');
    expect(result.map(({ text }) => text)).toEqual([
      'זהו המשפט הראשון כאן.',
      'זהו המשפט השני כאן.',
    ]);
  });

  it('splits Devanagari text on a danda', () => {
    const result = splitSentences('यह पहला वाक्य है। यह दूसरा वाक्य है।');
    expect(result.map(({ text }) => text)).toEqual(['यह पहला वाक्य है।', 'यह दूसरा वाक्य है।']);
  });

  it('splits Chinese text on an ideographic full stop with no following space', () => {
    const result = splitSentences('这是第一个句子。这是第二个句子。');
    expect(result.map(({ text }) => text)).toEqual(['这是第一个句子。', '这是第二个句子。']);
  });

  it('splits Japanese text on a full-width exclamation mark', () => {
    const result = splitSentences('これは最初の文です！これは二番目の文です。');
    expect(result).toHaveLength(2);
  });

  it('counts Han characters individually so CJK sentences survive short-span merging', () => {
    // With whitespace-run counting each clause would be one "word" and the two
    // would merge back into a single span.
    const result = splitSentences('这是第一个句子。这是第二个句子。', { minSentenceWords: 4 });
    expect(result).toHaveLength(2);
  });

  it('does not split before a lowercase accented continuation', () => {
    const text = 'Le café est ici. élan continue ici encore.';
    expect(splitSentences(text, { minSentenceWords: 1 })).toEqual([
      { text, start: 0, end: text.length },
    ]);
  });

  it('does not split on a period with no following whitespace', () => {
    const text = 'The build is version 3.5 and it works well.';
    expect(splitSentences(text, { minSentenceWords: 1 })).toEqual([
      { text, start: 0, end: text.length },
    ]);
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
