import { describe, expect, it, vi } from 'vitest';
import { buildTopicTagClouds } from './topicTagClouds.js';

describe('buildTopicTagClouds', () => {
  it('ranks each canonical leaf once using all assigned sentences in source order', async () => {
    const rank = vi.fn(async ({ title }) => [{ word: title.split('>').at(-1), weight: 0.8 }]);
    const result = await buildTopicTagClouds({
      topics: [
        { name: 'Root', sentences: [2] },
        { name: 'Root > Leaf', sentences: [3, 1] },
        { name: 'Root>Leaf', sentences: [4, 1] },
        { name: 'Root>Other', sentences: [2] },
      ],
      sentences: ['one', 'two', 'three', 'four'],
      rank,
    });
    expect(rank).toHaveBeenCalledTimes(2);
    expect(rank).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Root>Leaf', text: 'one three four' }),
    );
    expect(result['Root>Leaf']).toEqual([{ word: 'Leaf', weight: 0.8 }]);
    expect(result.Root).toEqual([
      { word: 'Leaf', weight: 0.8 },
      { word: 'Other', weight: 0.8 },
    ]);
  });

  it('aggregates all descendant scores before limiting each cloud and handles special paths', async () => {
    const rank = vi.fn(async ({ title }) =>
      title === '__proto__>A'
        ? [
            ...Array.from({ length: 16 }, (_, i) => ({ word: `a${i}`, weight: 1 })),
            { word: 'Shared', weight: 0.9 },
          ]
        : [{ word: 'shared', weight: 0.9 }],
    );
    const result = await buildTopicTagClouds({
      topics: [
        { name: '__proto__>A', sentences: [1] },
        { name: '__proto__>B', sentences: [2] },
      ],
      sentences: ['a', 'b'],
      rank,
    });
    expect(Object.hasOwn(result, '__proto__')).toBe(true);
    expect(result.__proto__[0]).toEqual({ word: 'Shared', weight: 1.8 });
    expect(result['__proto__>A']).toHaveLength(16);
  });
});
