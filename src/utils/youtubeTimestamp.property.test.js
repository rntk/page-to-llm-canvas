import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import {
  getYouTubeVideoId,
  parseTimestampSeconds,
  buildYouTubeTimestampUrl,
  formatTimestampLabel,
  getTimestampForSentences,
  getYouTubeTimestampLink,
} from './youtubeTimestamp.js';

describe('youtubeTimestamp properties', () => {
  describe('getYouTubeVideoId', () => {
    it('never throws for any random input string', () => {
      fc.assert(
        fc.property(fc.string(), (urlStr) => {
          expect(() => getYouTubeVideoId(urlStr)).not.toThrow();
        }),
      );
    });

    // YouTube IDs are typically 11 chars; minLength 1 guarantees every run asserts.
    const videoIdArb = fc.string({
      unit: fc.constantFrom('a', 'b', 'c', '1', '2', '3', '-', '_'),
      minLength: 1,
      maxLength: 11,
    });

    it('extracts ID for valid youtube.com watch URLs', () => {
      fc.assert(
        fc.property(videoIdArb, (id) => {
          const watchUrl = `https://www.youtube.com/watch?v=${id}`;
          expect(getYouTubeVideoId(watchUrl)).toBe(id);

          const mobileUrl = `https://m.youtube.com/watch?v=${id}`;
          expect(getYouTubeVideoId(mobileUrl)).toBe(id);

          const musicUrl = `https://music.youtube.com/watch?v=${id}`;
          expect(getYouTubeVideoId(musicUrl)).toBe(id);
        }),
      );
    });

    it('extracts ID for valid youtu.be short URLs', () => {
      fc.assert(
        fc.property(videoIdArb, (id) => {
          const shortUrl = `https://youtu.be/${id}`;
          expect(getYouTubeVideoId(shortUrl)).toBe(id);
        }),
      );
    });

    it('extracts the exact ID from every supported YouTube path form', () => {
      fc.assert(
        fc.property(
          videoIdArb,
          fc.constantFrom('shorts', 'embed', 'v', 'live'),
          fc.constantFrom('youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com'),
          (id, pathKind, host) => {
            expect(getYouTubeVideoId(`https://${host}/${pathKind}/${id}`)).toBe(id);
          },
        ),
      );
    });

    it('rejects non-string inputs and lookalike YouTube hosts', () => {
      for (const input of [undefined, null, false, 0, {}, []]) {
        expect(getYouTubeVideoId(input)).toBeNull();
      }
      for (const host of ['youtube.com.example', 'notyoutube.com', 'youtu.be.example']) {
        expect(getYouTubeVideoId(`https://${host}/watch?v=abc123`)).toBeNull();
      }
      expect(getYouTubeVideoId('https://m.www.youtube.com/watch?v=abc123')).toBeNull();
      expect(getYouTubeVideoId('https://youtube.com/prefix/shorts/abc123')).toBeNull();
      expect(getYouTubeVideoId('https://youtube.com/not-a-video')).toBeNull();
    });
  });

  describe('formatTimestampLabel and parseTimestampSeconds round-trip', () => {
    it('parses formatted timestamp labels back to exact seconds', () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 359999 }), (seconds) => {
          // e.g. up to 100 hours
          const label = formatTimestampLabel(seconds);
          const parsed = parseTimestampSeconds(label);
          expect(parsed).toBe(seconds);
        }),
      );
    });

    it('parses formatted timestamp labels with padded minutes or forced hours back to exact seconds', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 359999 }),
          fc.boolean(),
          fc.boolean(),
          (seconds, padMinutes, forceHours) => {
            const label = formatTimestampLabel(seconds, { padMinutes, forceHours });
            const parsed = parseTimestampSeconds(label);
            expect(parsed).toBe(seconds);
          },
        ),
      );
    });

    it('never throws for arbitrary string input to parseTimestampSeconds', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          expect(() => parseTimestampSeconds(text)).not.toThrow();
        }),
      );
    });
  });

  describe('buildYouTubeTimestampUrl', () => {
    it('rejects every invalid video ID and seconds category exactly', () => {
      for (const videoId of ['', null, undefined]) {
        expect(buildYouTubeTimestampUrl(videoId, 10)).toBeNull();
      }
      for (const seconds of [null, undefined, Number.NaN, Infinity, -Infinity]) {
        expect(buildYouTubeTimestampUrl('video-id', seconds)).toBeNull();
      }
    });

    it('returns null for invalid inputs and proper URL for valid inputs', () => {
      fc.assert(
        fc.property(
          fc.option(fc.string(), { nil: undefined }),
          fc.option(fc.double(), { nil: undefined }),
          (videoId, seconds) => {
            const result = buildYouTubeTimestampUrl(videoId, seconds);
            if (!videoId || seconds == null || !Number.isFinite(seconds)) {
              expect(result).toBeNull();
            } else {
              expect(result).toContain(videoId);
              expect(result).toContain(`t=${Math.max(0, Math.floor(seconds))}s`);
            }
          },
        ),
      );
    });
  });

  describe('getTimestampForSentences', () => {
    it('rejects non-array and empty inputs exactly', () => {
      for (const sentences of [undefined, null, '', {}, []]) {
        expect(getTimestampForSentences(sentences, [1])).toBeNull();
      }
      for (const sourceSentences of [undefined, null, '', {}, []]) {
        expect(getTimestampForSentences(['0:07'], sourceSentences)).toBeNull();
      }
    });

    it('never throws and returns null or integer', () => {
      fc.assert(
        fc.property(fc.array(fc.string()), fc.array(fc.integer()), (sentences, sourceSentences) => {
          const result = getTimestampForSentences(sentences, sourceSentences);
          if (result !== null) {
            expect(Number.isInteger(result)).toBe(true);
            expect(result).toBeGreaterThanOrEqual(0);
          }
        }),
      );
    });

    it('uses the timestamp at the smallest valid one-based source sentence', () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 359999 }), { minLength: 1, maxLength: 30 }),
          fc.integer({ min: 1, max: 60 }),
          fc.array(
            fc.oneof(
              fc.integer({ max: 0 }),
              fc
                .double({ min: 0, max: 60, noNaN: true })
                .filter((value) => Number.isFinite(value) && !Number.isInteger(value)),
            ),
            { maxLength: 8 },
          ),
          (timestamps, target, invalidReferences) => {
            const sentences = timestamps.map((seconds) => formatTimestampLabel(seconds));
            const expectedIndex = Math.min(target - 1, sentences.length - 1);
            expect(getTimestampForSentences(sentences, [...invalidReferences, target])).toBe(
              timestamps[expectedIndex],
            );
          },
        ),
      );
    });

    it('scans backward to the nearest timestamp and respects the transcript-start fallback', () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 20 }),
          fc.integer({ min: 0, max: 359999 }),
          fc.integer({ min: 0, max: 20 }),
          (cueIndex, seconds, trailingCount) => {
            const sentences = [
              ...Array(cueIndex).fill('untimed sentence'),
              formatTimestampLabel(seconds),
              ...Array(trailingCount).fill('later untimed sentence'),
            ];
            expect(getTimestampForSentences(sentences, [sentences.length])).toBe(seconds);
            expect(getTimestampForSentences(sentences, [1])).toBe(0);
            if (cueIndex > 1) {
              expect(getTimestampForSentences(sentences, [cueIndex])).toBeNull();
            }
          },
        ),
      );

      expect(getTimestampForSentences(['untimed', 'still untimed'], [1])).toBeNull();
      expect(getTimestampForSentences(['0:07', 'later'], [0, -1, 1.5, Number.NaN])).toBeNull();
    });
  });

  describe('invalid formatting inputs', () => {
    it('returns the documented empty label for nullish and non-finite seconds', () => {
      for (const seconds of [null, undefined, Number.NaN, Infinity, -Infinity]) {
        expect(formatTimestampLabel(seconds)).toBe('');
      }
    });
  });

  describe('getYouTubeTimestampLink', () => {
    it('short-circuits invalid sources and missing timestamps', () => {
      const timestamped = { sentences: ['0:07'], sourceSentences: [1] };
      expect(
        getYouTubeTimestampLink({ sourceUrl: 'https://example.com', ...timestamped }),
      ).toBeNull();
      expect(
        getYouTubeTimestampLink({
          sourceUrl: 'https://youtube.com/watch?v=video-id',
          sentences: ['untimed'],
          sourceSentences: [1],
        }),
      ).toBeNull();
    });

    it('never throws and returns correct structured data or null', () => {
      fc.assert(
        fc.property(
          fc.record({
            sourceUrl: fc.option(fc.string(), { nil: undefined }),
            sentences: fc.option(fc.array(fc.string()), { nil: undefined }),
            sourceSentences: fc.option(fc.array(fc.integer()), { nil: undefined }),
            labelOptions: fc.option(
              fc.record({
                padMinutes: fc.boolean(),
                forceHours: fc.boolean(),
              }),
              { nil: undefined },
            ),
          }),
          (params) => {
            const result = getYouTubeTimestampLink(params);
            if (result !== null) {
              expect(result).toHaveProperty('url');
              expect(result).toHaveProperty('seconds');
              expect(result).toHaveProperty('label');
              expect(typeof result.url).toBe('string');
              expect(typeof result.seconds).toBe('number');
              expect(typeof result.label).toBe('string');
            }
          },
        ),
      );
    });
  });
});
