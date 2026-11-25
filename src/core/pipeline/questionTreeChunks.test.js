import { describe, expect, it } from 'vitest';
import { buildQuestionChunks } from './questionTreeChunks.js';

describe('buildQuestionChunks', () => {
  it('packs contiguous passages up to maxChars and skips blank sentences', () => {
    const sentences = [
      'First sentence.',
      '   ',
      'Second sentence.',
      'Third sentence.',
      'Fourth sentence.',
    ];
    const topics = [
      { name: 'A', sentences: [1, 3] },
      { name: 'B', sentences: [4, 5] },
    ];

    const chunks = buildQuestionChunks(sentences, topics, { maxChars: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    const allIds = chunks.flatMap((c) => c.sentences);
    expect(allIds).toEqual([1, 3, 4, 5]);
    expect(chunks.map((c) => c.id)).toEqual(chunks.map((_, i) => `c${i + 1}`));
  });

  it('packs all sentences into one chunk when within maxChars', () => {
    const sentences = ['Alpha.', 'Beta.', 'Gamma.'];
    const chunks = buildQuestionChunks(sentences, [], { maxChars: 1000 });
    expect(chunks).toEqual([{ id: 'c1', sentences: [1, 2, 3] }]);
  });

  it('returns empty array when all sentences are blank', () => {
    expect(buildQuestionChunks(['', '   '], [])).toEqual([]);
  });

  it('repacks oversized passages at sentence boundaries to respect maxChars', () => {
    const sentences = Array.from({ length: 4 }, (_, i) => `S${i + 1}: `.padEnd(200, 'a'));
    const topics = [{ name: 'SingleTopic', sentences: [1, 2, 3, 4] }];
    const chunks = buildQuestionChunks(sentences, topics, { maxChars: 439 });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flatMap((c) => c.sentences)).toEqual([1, 2, 3, 4]);
    for (const chunk of chunks) {
      const chunkChars = chunk.sentences.reduce((sum, id) => sum + sentences[id - 1].length + 1, 0);
      expect(chunkChars).toBeLessThanOrEqual(439);
    }
  });

  it('keeps an individual sentence longer than maxChars in its own chunk', () => {
    const sentences = ['x'.repeat(500), 'short'];
    const chunks = buildQuestionChunks(sentences, [], { maxChars: 100 });
    expect(chunks).toEqual([
      { id: 'c1', sentences: [1] },
      { id: 'c2', sentences: [2] },
    ]);
  });
});
