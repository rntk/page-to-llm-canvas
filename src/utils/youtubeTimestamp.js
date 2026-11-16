// Build YouTube deep links from transcript cues such as "2:51 2 minutes, 51 seconds".

// Match duration-backed or standalone M:SS/H:MM:SS cues, excluding ratios and clock times.
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
 * Timestamp (seconds) at the start of a card's source sentences: scans backward from
 * the first sentence to the nearest inline timestamp. Source sentence numbers are
 * one-based.
 *
 * Returns null when the first source sentence is past the transcript end (a stale
 * reference, so the card is dropped rather than pinned to the last cue).
 *
 * A card starting at the transcript's first line with no timestamp (e.g. a title)
 * anchors to 0s, but only if a later cue exists. A transcript with no timestamps
 * is not synced, so those cards resolve to null.
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
  // Before the first cue, use 0s only if the transcript has a later cue.
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
 * `padMinutes` (`02:51`) and `forceHours` (`0:02:51`) give uniform label widths so
 * links don't shift in views like the hierarchy.
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
