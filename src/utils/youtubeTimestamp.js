// Helpers for turning a YouTube transcript record into "jump to this moment"
// links. The page-to-LLM YouTube extension captures the transcript with inline
// timestamps embedded in the sentence text, e.g.
//   "2:51 2 minutes, 51 seconds I've had issues with that"
// We detect that the record came from YouTube (via its sourceUrl), pull the
// nearest preceding timestamp for a card's source sentences, and build a
// deep-link like https://www.youtube.com/watch?v=ID&t=171s.

// A timestamp token (M:SS or H:MM:SS) anchored either on the trailing human-readable
// duration the transcript sometimes emits ("1 second", "2 minutes, 51 seconds") or
// as a standalone timestamp (e.g. "0:00", "19:37", "1:03:06").
// The anchor or boundary constraints prevent matching ratios (16:9) or clock times (3:30 PM).
const TIMESTAMP_RE =
  /(?:^|\b)(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?=\s+\d+\s+(?:second|minute|hour)|(?:\s|$|\b)(?!\s*[ap]\.?m\.?))/i;

/**
 * Extract the YouTube video id from a watch/short/embed/youtu.be URL.
 * @param {string} sourceUrl
 * @returns {string | null}
 */
export function getYouTubeVideoId(sourceUrl) {
  if (!sourceUrl || typeof sourceUrl !== 'string') return null;
  let url;
  try {
    url = new URL(sourceUrl);
  } catch {
    return null;
  }
  const host = url.hostname.replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = url.pathname.slice(1).split('/')[0];
    return id || null;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    if (url.pathname === '/watch') return url.searchParams.get('v') || null;
    const pathMatch = url.pathname.match(/^\/(?:shorts|embed|v|live)\/([^/?#]+)/);
    if (pathMatch) return pathMatch[1];
  }
  return null;
}

/**
 * Parse the first transcript timestamp in a sentence into total seconds.
 * @param {string} text
 * @returns {number | null}
 */
export function parseTimestampSeconds(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(TIMESTAMP_RE);
  if (!match) return null;
  const first = Number(match[1]);
  const second = Number(match[2]);
  const third = match[3] != null ? Number(match[3]) : null;
  // Three groups => H:MM:SS, otherwise M:SS.
  return third != null ? first * 3600 + second * 60 + third : first * 60 + second;
}

/**
 * Find the timestamp (in seconds) that best marks the start of a card's source
 * sentences by scanning backward from the card's first sentence to the nearest
 * preceding inline timestamp.
 *
 * Source sentence numbers use the canonical one-based record contract. A card
 * whose earliest source sentence lies past the end of the transcript is not
 * locatable in the video (a stale or hallucinated reference), so it resolves to
 * null and gets dropped rather than being pinned to the last transcript cue.
 *
 * When the card's first sentence sits at the very start of the transcript but
 * that opening line carries no inline timestamp (e.g. a title or greeting before
 * the first "0:00" cue), the backward scan finds nothing. We then anchor the card
 * to the start of the video (0s) so the first topic still appears on the rail and
 * its deep-links resolve — but only if the transcript is timestamped somewhere
 * downstream. A transcript with no parseable timestamps at all isn't a synced
 * transcript, so those cards still resolve to null and get dropped.
 *
 * @param {string[]} sentences
 * @param {number[]} sourceSentences
 * @returns {number | null}
 */
export function getTimestampForSentences(sentences, sourceSentences) {
  if (!Array.isArray(sentences) || sentences.length === 0) return null;
  if (!Array.isArray(sourceSentences) || sourceSentences.length === 0) return null;
  const numbers = sourceSentences.filter((n) => Number.isInteger(n) && n > 0);
  if (numbers.length === 0) return null;
  const startSentence = Math.min(...numbers);
  if (startSentence > sentences.length) return null;
  const startIndex = startSentence - 1;
  for (let i = startIndex; i >= 0; i -= 1) {
    const seconds = parseTimestampSeconds(sentences[i]);
    if (seconds != null) return seconds;
  }
  // Card anchored at the transcript start with no timestamp on its opening line:
  // fall back to video-start 0s, provided a timestamp exists further down (so a
  // genuinely un-timestamped transcript still yields no card).
  if (startIndex === 0) {
    for (let i = 1; i < sentences.length; i += 1) {
      if (parseTimestampSeconds(sentences[i]) != null) return 0;
    }
  }
  return null;
}

/**
 * @param {string} videoId
 * @param {number} seconds
 * @returns {string | null}
 */
export function buildYouTubeTimestampUrl(videoId, seconds) {
  if (!videoId || seconds == null || !Number.isFinite(seconds)) return null;
  return `https://www.youtube.com/watch?v=${videoId}&t=${Math.max(0, Math.floor(seconds))}s`;
}

/**
 * Format seconds as a compact transcript label (m:ss or h:mm:ss).
 *
 * Options let a caller render every label in a view at a uniform width so the
 * links don't shift left/right (e.g. the hierarchy view): `padMinutes` forces
 * two-digit minutes (`02:51` instead of `2:51`) and `forceHours` always shows
 * the hours field (`0:02:51`) even for sub-hour timestamps. Both default off, so
 * the bare call is unchanged for existing callers (canvas views).
 *
 * @param {number} seconds
 * @param {object} [options]
 * @param {boolean} [options.padMinutes]
 * @param {boolean} [options.forceHours]
 * @returns {string}
 */
export function formatTimestampLabel(seconds, options = {}) {
  if (seconds == null || !Number.isFinite(seconds)) return '';
  const { padMinutes = false, forceHours = false } = options;
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  const showHours = hours > 0 || forceHours;
  const minStr = showHours || padMinutes ? pad(minutes) : String(minutes);
  return showHours ? `${hours}:${minStr}:${pad(secs)}` : `${minStr}:${pad(secs)}`;
}

/**
 * Resolve a YouTube deep-link for a single card. Returns null when the record
 * isn't a YouTube transcript or no timestamp can be found, so callers can render
 * the button conditionally.
 *
 * @param {object} params
 * @param {string} [params.sourceUrl]
 * @param {string[]} [params.sentences]
 * @param {number[]} [params.sourceSentences]
 * @param {object} [params.labelOptions]
 * @param {boolean} [params.labelOptions.padMinutes]
 * @param {boolean} [params.labelOptions.forceHours]
 * @returns {({ url: string, seconds: number, label: string }|null)}
 */
export function getYouTubeTimestampLink({ sourceUrl, sentences, sourceSentences, labelOptions }) {
  const videoId = getYouTubeVideoId(sourceUrl);
  if (!videoId) return null;
  const seconds = getTimestampForSentences(sentences, sourceSentences);
  if (seconds == null) return null;
  const url = buildYouTubeTimestampUrl(videoId, seconds);
  if (!url) return null;
  return { url, seconds, label: formatTimestampLabel(seconds, labelOptions) };
}
