import { describe, expect, it } from 'vitest';
import { cleanText, parseQuestionGroups, parseQuestionSections } from './questionTreeParse.js';

describe('questionTreeParse', () => {
  it('strips > and collapses whitespace in cleanText', () => {
    expect(cleanText('  Why > read\n  this?  ', 200)).toBe('Why read this?');
    expect(cleanText(123, 200)).toBe('');
  });

  it('repairs coverage from starts only, sorts, clamps, dedupes, and ignores end', () => {
    const raw = JSON.stringify({
      sections: [
        {
          question: 'Second > part?',
          answer: 'Second answer.',
          start: '7',
          end: 99,
          points: [{ text: 'Fact two', from: ['7', '8-10'] }],
        },
        {
          question: 'First part?',
          answer: 'First answer.',
          start: 3,
          points: [],
        },
        {
          question: 'Duplicate start ignored?',
          answer: 'Should be dropped.',
          start: 7,
          points: [],
        },
        {
          question: 'Clamped late?',
          answer: 'Clamped to last.',
          start: 999,
          points: [],
        },
      ],
    });

    const parsed = parseQuestionSections(raw, [2, 3, 5, 7, 8, 10]);
    expect(parsed).toEqual([
      {
        question: 'First part?',
        answer: 'First answer.',
        sentences: [2, 3, 5],
        points: [],
      },
      {
        question: 'Second part?',
        answer: 'Second answer.',
        sentences: [7, 8],
        points: [{ text: 'Fact two', sentences: [7, 8] }],
      },
      {
        question: 'Clamped late?',
        answer: 'Clamped to last.',
        sentences: [10],
        points: [],
      },
    ]);
  });

  it('clips point citations to section sentences and drops invalid or excess points', () => {
    const raw = JSON.stringify({
      sections: [
        {
          question: 'Q?',
          answer: 'A.',
          start: 1,
          points: [
            { text: 'Valid', from: ['1', '2-3', '99'] },
            { text: 'Outside only', from: ['50'] },
            { text: '', from: ['1'] },
            { text: 'P2', from: [2] },
            { text: 'P3', from: ['1'] },
            { text: 'P4', from: ['2'] },
            { text: 'P5', from: ['3'] },
            { text: 'P6', from: ['1'] },
            { text: 'P7 dropped', from: ['1'] },
          ],
        },
      ],
    });

    const parsed = parseQuestionSections(raw, [1, 2, 3]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].points).toHaveLength(6);
    expect(parsed[0].points[0]).toEqual({ text: 'Valid', sentences: [1, 2, 3] });
    expect(parsed[0].points.map((p) => p.text)).not.toContain('Outside only');
    expect(parsed[0].points.map((p) => p.text)).not.toContain('P7 dropped');
  });

  it('returns null for garbage or empty sections', () => {
    expect(parseQuestionSections('not json', [1, 2])).toBeNull();
    expect(parseQuestionSections('{"sections": []}', [1, 2])).toBeNull();
    expect(
      parseQuestionSections(JSON.stringify({ sections: [{ question: '', answer: 'A', start: 1 }] }), [
        1,
      ]),
    ).toBeNull();
  });

  it('preserves > in section and group answers while stripping it from path segments', () => {
    const sectionsRaw = JSON.stringify({
      sections: [
        {
          question: 'When > retry?',
          answer: 'Retry when latency > 200 ms.',
          start: 1,
          points: [{ text: 'Latency > 200 ms triggers retry', from: ['1'] }],
        },
      ],
    });
    const parsedSections = parseQuestionSections(sectionsRaw, [1]);
    expect(parsedSections).toEqual([
      {
        question: 'When retry?',
        answer: 'Retry when latency > 200 ms.',
        sentences: [1],
        points: [{ text: 'Latency 200 ms triggers retry', sentences: [1] }],
      },
    ]);

    const groupsRaw = JSON.stringify({
      groups: [
        { question: 'Group > 1?', answer: 'Latency > 200 ms.', items: ['Q1'] },
        { question: 'Group 2?', answer: 'Errors > 5%.', items: ['Q2'] },
      ],
    });
    expect(parseQuestionGroups(groupsRaw, 2)).toEqual([
      { question: 'Group 1?', answer: 'Latency > 200 ms.', sections: [0] },
      { question: 'Group 2?', answer: 'Errors > 5%.', sections: [1] },
    ]);
  });

  it('validates contiguous ordered coverage in parseQuestionGroups', () => {
    const valid = JSON.stringify({
      groups: [
        { question: 'Group 1?', answer: 'Answer 1.', items: ['Q1', 'Q2'] },
        { question: 'Group 2?', answer: 'Answer 2.', items: ['Q3', 'Q4'] },
      ],
    });
    expect(parseQuestionGroups(valid, 4)).toEqual([
      { question: 'Group 1?', answer: 'Answer 1.', sections: [0, 1] },
      { question: 'Group 2?', answer: 'Answer 2.', sections: [2, 3] },
    ]);

    // Out of order
    expect(
      parseQuestionGroups(
        JSON.stringify({
          groups: [
            { question: 'G1', answer: 'A1', items: ['Q2', 'Q1'] },
            { question: 'G2', answer: 'A2', items: ['Q3'] },
          ],
        }),
        3,
      ),
    ).toBeNull();

    // Missing item
    expect(
      parseQuestionGroups(
        JSON.stringify({
          groups: [
            { question: 'G1', answer: 'A1', items: ['Q1'] },
            { question: 'G2', answer: 'A2', items: ['Q3'] },
          ],
        }),
        3,
      ),
    ).toBeNull();

    // Fewer than 2 groups
    expect(
      parseQuestionGroups(
        JSON.stringify({
          groups: [{ question: 'G1', answer: 'A1', items: ['Q1', 'Q2'] }],
        }),
        2,
      ),
    ).toBeNull();
  });
});
