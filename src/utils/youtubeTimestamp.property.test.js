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
        { numRuns: 300 }
      );
    });

    it('extracts ID for valid youtube.com watch URLs', () => {
      fc.assert(
        fc.property(
          fc.string({ unit: fc.constantFrom('a', 'b', 'c', '1', '2', '3', '-', '_') }),
          (id) => {
            const cleanId = id.slice(0, 11); // YouTube IDs are typically 11 chars
            if (cleanId.length === 0) return;
            const watchUrl = `https://www.youtube.com/watch?v=${cleanId}`;
            expect(getYouTubeVideoId(watchUrl)).toBe(cleanId);

            const mobileUrl = `https://m.youtube.com/watch?v=${cleanId}`;
            expect(getYouTubeVideoId(mobileUrl)).toBe(cleanId);

            const musicUrl = `https://music.youtube.com/watch?v=${cleanId}`;
            expect(getYouTubeVideoId(musicUrl)).toBe(cleanId);
          }
        ),
        { numRuns: 200 }
      );
    });

    it('extracts ID for valid youtu.be short URLs', () => {
      fc.assert(
        fc.property(
          fc.string({ unit: fc.constantFrom('a', 'b', 'c', '1', '2', '3', '-', '_') }),
          (id) => {
            const cleanId = id.slice(0, 11);
            if (cleanId.length === 0) return;
            const shortUrl = `https://youtu.be/${cleanId}`;
            expect(getYouTubeVideoId(shortUrl)).toBe(cleanId);
          }
        ),
        { numRuns: 200 }
      );
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
        { numRuns: 500 }
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
          }
        ),
        { numRuns: 500 }
      );
    });

    it('never throws for arbitrary string input to parseTimestampSeconds', () => {
      fc.assert(
        fc.property(fc.string(), (text) => {
          expect(() => parseTimestampSeconds(text)).not.toThrow();
        }),
        { numRuns: 300 }
      );
    });
  });

  describe('buildYouTubeTimestampUrl', () => {
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
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  describe('getTimestampForSentences', () => {
    it('never throws and returns null or integer', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string()),
          fc.array(fc.integer()),
          (sentences, sourceSentences) => {
            const result = getTimestampForSentences(sentences, sourceSentences);
            if (result !== null) {
              expect(Number.isInteger(result)).toBe(true);
              expect(result).toBeGreaterThanOrEqual(0);
            }
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  describe('getYouTubeTimestampLink', () => {
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
              { nil: undefined }
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
          }
        ),
        { numRuns: 300 }
      );
    });
  });
});
