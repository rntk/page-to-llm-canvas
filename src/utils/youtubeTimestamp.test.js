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

  it('rejects truthy non-string inputs, including URL-coercible objects', () => {
    expect(getYouTubeVideoId({})).toBeNull();
    expect(getYouTubeVideoId([])).toBeNull();
    expect(getYouTubeVideoId(123)).toBeNull();
    expect(getYouTubeVideoId(new URL('https://www.youtube.com/watch?v=coercible'))).toBeNull();
  });
});

describe('parseTimestampSeconds', () => {
  it('parses M:SS anchored on the readable duration', () => {
    expect(parseTimestampSeconds('0:01 1 second This is a sample sentence.')).toBe(1);
    expect(parseTimestampSeconds('2:51 2 minutes, 51 seconds Hello world')).toBe(171);
    expect(parseTimestampSeconds('1:09 1 minute, 9 seconds First topic details')).toBe(69);
  });

  it('parses H:MM:SS', () => {
    expect(parseTimestampSeconds('1:02:03 1 hour, 2 minutes, 3 seconds sample description')).toBe(
      3723,
    );
  });

  it('parses standalone timestamps (new format)', () => {
    expect(parseTimestampSeconds('0:00 Introduction to the presentation')).toBe(0);
    expect(parseTimestampSeconds('19:37 Discussing the second alternative option')).toBe(1177);
    expect(parseTimestampSeconds('1:03:06 Let us move on to the final part')).toBe(3786);
    expect(
      parseTimestampSeconds('Some leading text here,   0:09 and a timestamp inside the sentence'),
    ).toBe(9);
  });

  it('ignores ratios and clock times lacking a duration anchor', () => {
    expect(parseTimestampSeconds('aspect ratio 16:9 looks good')).toBeNull();
    expect(parseTimestampSeconds('see you at 3:30 PM tomorrow')).toBeNull();
  });

  it('returns null when no timestamp is present', () => {
    expect(
      parseTimestampSeconds('This is a simple text sentence without any time info.'),
    ).toBeNull();
    expect(parseTimestampSeconds('')).toBeNull();
  });

  it('returns null for truthy non-string input', () => {
    expect(parseTimestampSeconds({})).toBeNull();
    expect(parseTimestampSeconds([])).toBeNull();
    expect(parseTimestampSeconds(123)).toBeNull();
  });
});

describe('getTimestampForSentences', () => {
  const sentences = [
    '0:01 1 second Welcome to the overview.', // index 0 -> sentence 1
    'This is the first section.', // index 1 -> sentence 2
    'Let us continue to the next part.', // index 2 -> sentence 3
    '0:26 26 seconds Next key concept details.', // index 3 -> sentence 4
  ];

  it('returns the nearest preceding timestamp for a 1-based card', () => {
    expect(getTimestampForSentences(sentences, [3])).toBe(1);
    expect(getTimestampForSentences(sentences, [4])).toBe(26);
  });

  it('does not return null at the boundary (first card)', () => {
    expect(getTimestampForSentences(sentences, [1])).toBe(1);
  });

  it('anchors a transcript-start card with no leading timestamp to 0s', () => {
    // A title/greeting precedes the first cue, so the first topic's opening
    // sentence has no inline timestamp and nothing precedes it.
    const withIntro = [
      'Welcome to the channel', // index 0 -> sentence 1, no timestamp
      '0:05 5 seconds first topic', // index 1 -> sentence 2
      '1:00 1 minute second topic', // index 2 -> sentence 3
    ];
    expect(getTimestampForSentences(withIntro, [1, 2])).toBe(0); // 1-based first topic
  });

  it('still returns null when the transcript has no timestamps at all', () => {
    expect(getTimestampForSentences(['plain text', 'still no timestamp'], [1, 2])).toBeNull();
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

  it('pads minutes to two digits with padMinutes (uniform-width labels)', () => {
    expect(formatTimestampLabel(171, { padMinutes: true })).toBe('02:51');
    expect(formatTimestampLabel(1177, { padMinutes: true })).toBe('19:37');
    // Hours already pad minutes regardless of the option.
    expect(formatTimestampLabel(3723, { padMinutes: true })).toBe('1:02:03');
  });

  it('always shows the hours field with forceHours', () => {
    expect(formatTimestampLabel(171, { forceHours: true })).toBe('0:02:51');
    expect(formatTimestampLabel(171, { padMinutes: true, forceHours: true })).toBe('0:02:51');
    expect(formatTimestampLabel(3723, { forceHours: true })).toBe('1:02:03');
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
