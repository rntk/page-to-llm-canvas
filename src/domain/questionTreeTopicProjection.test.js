import { describe, expect, it } from 'vitest';
import { projectQuestionTreeTopics } from './questionTreeTopicProjection.js';

describe('projectQuestionTreeTopics', () => {
  const sentences = [
    'First sentence.',
    'Second sentence.',
    'Third sentence.',
    'Fourth sentence.',
    'Fifth sentence.',
  ];

  it('projects sections, answers, points, and multi-section groups', () => {
    const tree = {
      chunks: [
        {
          id: 'c1',
          sentences: [1, 2, 3, 4, 5],
          sections: [
            {
              question: 'Why read > this?',
              answer: 'Because it explains X.',
              sentences: [1, 2],
              points: [{ text: 'Point > one', sentences: [1, 2] }],
            },
            {
              question: 'Why read > this?',
              answer: 'Duplicate sibling title gets suffixed.',
              sentences: [3],
              points: [],
            },
            {
              question: 'Solo question?',
              answer: 'Solo answer.',
              sentences: [4, 5],
              points: [{ text: 'Solo point', sentences: [5] }],
            },
          ],
        },
      ],
      groups: [
        { question: 'Main > group?', answer: 'Group summary.', sections: [0, 1] },
        { question: 'Single section group?', answer: 'Flattened.', sections: [2] },
      ],
    };

    const projected = projectQuestionTreeTopics(tree, sentences);
    expect(projected.topics).toEqual([
      { name: 'Main group?>Why read this?', sentences: [1, 2] },
      { name: 'Main group?>Why read this?>Point one', sentences: [1, 2] },
      { name: 'Main group?>Why read this? (2)', sentences: [3] },
      { name: 'Solo question?', sentences: [4, 5] },
      { name: 'Solo question?>Solo point', sentences: [5] },
    ]);

    expect(projected.topic_summary_index['Main group?']).toMatchObject({
      level: 0,
      source_sentences: [1, 2, 3],
      runs: [{ sentences: [1, 2, 3], text: 'Group summary.' }],
    });
    expect(projected.topic_summary_index['Main group?>Why read this?']).toMatchObject({
      level: 1,
      source_sentences: [1, 2],
      runs: [{ sentences: [1, 2], text: 'Because it explains X.' }],
    });
    expect(projected.topic_summary_index['Main group?>Why read this?>Point one']).toMatchObject({
      level: 2,
      source_sentences: [1, 2],
      runs: [{ sentences: [1, 2], text: 'First sentence. Second sentence.' }],
    });
    expect(projected.topic_summary_index['Solo question?']).toMatchObject({
      level: 0,
      source_sentences: [4, 5],
      runs: [{ sentences: [4, 5], text: 'Solo answer.' }],
    });
    expect(projected.topic_summary_index['Solo question?>Solo point']).toMatchObject({
      level: 1,
      source_sentences: [5],
      runs: [{ sentences: [5], text: 'Fifth sentence.' }],
    });
    expect(projected.topic_summary_index['Single section group?']).toBeUndefined();
  });

  it('returns null when there are no sections', () => {
    expect(projectQuestionTreeTopics({ chunks: [] }, sentences)).toBeNull();
    expect(projectQuestionTreeTopics(null, sentences)).toBeNull();
  });
});
