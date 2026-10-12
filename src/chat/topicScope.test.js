import { describe, expect, it } from 'vitest';
import { buildTopicTree } from '../domain/topicTree.js';
import { normalizeChatScope, scopeChatSentences } from './topicScope.js';

describe('normalizeChatScope', () => {
  it('normalizes a nested tree node fullPath and removes duplicate paths', () => {
    const [root] = buildTopicTree([{ name: 'Research > Methods > Sampling', sentences: [1] }]);
    const nested = root.children.get('Methods').children.get('Sampling');

    expect(
      scopeChatSentences(
        ['Sampling detail.', 'Other detail.'],
        [
          { name: 'Research > Methods > Sampling', sentences: [1] },
          { name: 'Research > Methods > Other', sentences: [2] },
        ],
        [nested.node.fullPath],
      ),
    ).toEqual(['Sampling detail.', '']);
    expect(normalizeChatScope([nested.node.fullPath, 'Research > Methods > Sampling'])).toEqual([
      'Research > Methods > Sampling',
    ]);
  });
});

describe('scopeChatSentences', () => {
  it('combines selected paths and descendants while retaining source line numbers', () => {
    const sentences = [
      'Recurring sentence.',
      'Alpha detail.',
      'Recurring sentence.',
      'Beta detail.',
    ];
    const topics = [
      { name: 'Alpha', sentences: [1] },
      { name: 'Alpha > Detail', sentences: [2] },
      { name: 'Beta', sentences: [3] },
      { name: 'Beta > Detail', sentences: [4] },
    ];

    expect(scopeChatSentences(sentences, topics, ['Alpha > Detail', 'Beta'])).toEqual([
      '',
      'Alpha detail.',
      'Recurring sentence.',
      'Beta detail.',
    ]);
  });

  it('includes all descendants of a selected path without leaking unrelated recurring text', () => {
    const sentences = ['Shared wording.', 'Child text.', 'Shared wording.', 'Other child.'];
    const topics = [
      { name: 'Research > Child', sentences: [1, 2] },
      { name: 'Research > Other', sentences: [3, 4] },
      { name: 'Research > Child > Grandchild', sentences: [2] },
    ];

    expect(scopeChatSentences(sentences, topics, ['Research > Child'])).toEqual([
      'Shared wording.',
      'Child text.',
      '',
      '',
    ]);
  });

  it('returns the original sentence list for whole-document scope', () => {
    const sentences = ['One', 'Two'];
    expect(scopeChatSentences(sentences, [], [])).toBe(sentences);
  });

  it('normalizes selected paths before matching sentence indexes', () => {
    const sentences = ['Selected.', 'Other.'];
    const topics = [
      { name: 'Research > Child', sentences: [1] },
      { name: 'Research > Other', sentences: [2] },
    ];

    expect(scopeChatSentences(sentences, topics, ['Research>Child'])).toEqual(['Selected.', '']);
  });
});
