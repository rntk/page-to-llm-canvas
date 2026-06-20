import { describe, it, expect } from 'vitest';
import {
  getYouTubeVideoId,
  parseTimestampSeconds,
  getTimestampForSentences,
  buildYouTubeTimestampUrl,
  formatTimestampLabel,
  getYouTubeTimestampLink,
} from './youtubeTimestamp.js';

describe('getYouTubeVideoId', () => {
  it('parses a standard watch URL', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/watch?v=WUw9XUOAFaY')).toBe('WUw9XUOAFaY');
  });

  it('parses youtu.be short links', () => {
    expect(getYouTubeVideoId('https://youtu.be/WUw9XUOAFaY?t=10')).toBe('WUw9XUOAFaY');
  });

  it('parses shorts, embed and live paths', () => {
    expect(getYouTubeVideoId('https://www.youtube.com/shorts/abc123')).toBe('abc123');
    expect(getYouTubeVideoId('https://www.youtube.com/embed/abc123')).toBe('abc123');
    expect(getYouTubeVideoId('https://www.youtube.com/live/abc123')).toBe('abc123');
  });

  it('handles m. and music. subdomains', () => {
    expect(getYouTubeVideoId('https://m.youtube.com/watch?v=xyz')).toBe('xyz');
    expect(getYouTubeVideoId('https://music.youtube.com/watch?v=xyz')).toBe('xyz');
  });

  it('returns null for non-YouTube or invalid URLs', () => {
    expect(getYouTubeVideoId('https://example.com/watch?v=xyz')).toBeNull();
    expect(getYouTubeVideoId('not a url')).toBeNull();
    expect(getYouTubeVideoId('')).toBeNull();
    expect(getYouTubeVideoId(null)).toBeNull();
  });
});

describe('parseTimestampSeconds', () => {
  it('parses M:SS anchored on the readable duration', () => {
    expect(parseTimestampSeconds("0:01 1 second Yeah, I don't know.")).toBe(1);
    expect(parseTimestampSeconds('2:51 2 minutes, 51 seconds I had issues')).toBe(171);
    expect(parseTimestampSeconds('1:09 1 minute, 9 seconds Sapphire Rapids')).toBe(69);
  });

  it('parses H:MM:SS', () => {
    expect(parseTimestampSeconds('1:02:03 1 hour, 2 minutes, 3 seconds onward')).toBe(3723);
  });

  it('ignores ratios and clock times lacking a duration anchor', () => {
    expect(parseTimestampSeconds('aspect ratio 16:9 looks good')).toBeNull();
    expect(parseTimestampSeconds('see you at 3:30 PM tomorrow')).toBeNull();
  });

  it('returns null when no timestamp is present', () => {
    expect(parseTimestampSeconds("And uh it's going to be fun.")).toBeNull();
    expect(parseTimestampSeconds('')).toBeNull();
  });
});

describe('getTimestampForSentences', () => {
  const sentences = [
    "0:01 1 second Yeah, I don't know.", // index 0 -> sentence 1
    "That's why we're here.", // index 1 -> sentence 2
    "And uh it's going to be fun.", // index 2 -> sentence 3
    '0:26 26 seconds Blackwell is not just a card.', // index 3 -> sentence 4
  ];

  it('returns the nearest preceding timestamp for a 1-based card', () => {
    expect(getTimestampForSentences(sentences, [3])).toBe(1);
    expect(getTimestampForSentences(sentences, [4])).toBe(26);
  });

  it('applies the +1 offset when a leading 0 is present', () => {
    // 0-based numbering: source 2 -> array index 3 (0:26)
    expect(getTimestampForSentences(sentences, [0, 1, 2])).toBe(1);
    expect(getTimestampForSentences(sentences, [3])).toBe(1);
  });

  it('does not return null at the boundary (first card)', () => {
    expect(getTimestampForSentences(sentences, [1])).toBe(1);
  });

  it('returns null for empty input', () => {
    expect(getTimestampForSentences([], [1])).toBeNull();
    expect(getTimestampForSentences(sentences, [])).toBeNull();
  });
});

describe('buildYouTubeTimestampUrl', () => {
  it('builds a deep link with floored seconds', () => {
    expect(buildYouTubeTimestampUrl('abc', 171.9)).toBe(
      'https://www.youtube.com/watch?v=abc&t=171s',
    );
  });

  it('returns null without a video id or seconds', () => {
    expect(buildYouTubeTimestampUrl('', 10)).toBeNull();
    expect(buildYouTubeTimestampUrl('abc', null)).toBeNull();
  });
});

describe('formatTimestampLabel', () => {
  it('formats m:ss and h:mm:ss', () => {
    expect(formatTimestampLabel(1)).toBe('0:01');
    expect(formatTimestampLabel(171)).toBe('2:51');
    expect(formatTimestampLabel(3723)).toBe('1:02:03');
  });
});

describe('getYouTubeTimestampLink', () => {
  const sentences = ['0:01 1 second hello', 'no stamp here', '0:26 26 seconds again'];

  it('returns a full link for a YouTube record', () => {
    expect(
      getYouTubeTimestampLink({
        sourceUrl: 'https://www.youtube.com/watch?v=WUw9XUOAFaY',
        sentences,
        sourceSentences: [3],
      }),
    ).toEqual({
      url: 'https://www.youtube.com/watch?v=WUw9XUOAFaY&t=26s',
      seconds: 26,
      label: '0:26',
    });
  });

  it('returns null for non-YouTube records', () => {
    expect(
      getYouTubeTimestampLink({
        sourceUrl: 'https://example.com/post',
        sentences,
        sourceSentences: [1],
      }),
    ).toBeNull();
  });

  it('returns null when no timestamp can be found', () => {
    expect(
      getYouTubeTimestampLink({
        sourceUrl: 'https://www.youtube.com/watch?v=abc',
        sentences: ['no stamps at all', 'still nothing'],
        sourceSentences: [1],
      }),
    ).toBeNull();
  });
});
