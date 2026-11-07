// The excerpt chat's `read_page` tool: lets the model read the page an excerpt
// was taken from, a bounded window of numbered page lines at a time.

export const READ_PAGE_TOOL = Object.freeze({
  name: 'read_page',
  description:
    'Read the full web page the excerpt was taken from, as numbered page lines. Use it only when the excerpt alone cannot answer the question. Without start_line it starts a little before the excerpt. Call again with next_start_line to keep reading.',
  parameters: {
    type: 'object',
    properties: {
      start_line: {
        type: 'integer',
        description: 'First page line to read, 1-based. Omit to start near the excerpt.',
      },
    },
    additionalProperties: false,
  },
});

// Lines read before the excerpt when no start_line is given, for context.
const LEAD_IN_LINES = 5;
// Characters of an excerpt sentence used to find it on the page.
const PROBE_CHARS = 60;
// Shortest line ending accepted as the start of a mid-sentence excerpt.
const MIN_OVERLAP_CHARS = 12;

const squash = (text) =>
  String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/**
 * One-based page line where the excerpt starts, or null when it is not found.
 * @param {string[]} pageSentences
 * @param {string[]} excerptSentences
 * @returns {number|null}
 */
export function locateExcerpt(pageSentences, excerptSentences) {
  const probe = squash(excerptSentences.find((sentence) => squash(sentence))).slice(0, PROBE_CHARS);
  if (!probe) return null;
  const index = pageSentences.findIndex((sentence) => squash(sentence).includes(probe));
  if (index >= 0) return index + 1;
  // The selection may start mid-sentence and run past it: find the page line
  // whose ending is where the excerpt begins.
  const fallback = pageSentences.findIndex((sentence) => {
    const line = squash(sentence);
    for (
      let length = Math.min(line.length, probe.length);
      length >= MIN_OVERLAP_CHARS;
      length -= 1
    ) {
      if (line.endsWith(probe.slice(0, length))) return true;
    }
    return false;
  });
  return fallback >= 0 ? fallback + 1 : null;
}

/**
 * @param {object} options
 * @param {function(): Promise<{sentences: string[]}>} options.loadPage
 *   Reads the page; callers cache it so repeated reads cost one capture.
 * @param {string[]} options.excerptSentences
 * @returns {{definition: object, run: function(object, {maxChars: number}): Promise<string>}}
 */
export function createReadPageTool({ loadPage, excerptSentences }) {
  return {
    definition: READ_PAGE_TOOL,
    async run(args, { maxChars }) {
      const page = await loadPage();
      const sentences = Array.isArray(page?.sentences) ? page.sentences : [];
      if (!sentences.length) throw new Error('the page has no readable text');
      const totalLines = sentences.length;
      const excerptLine = locateExcerpt(sentences, excerptSentences);
      const requested = Number(args?.start_line);
      const startLine = Number.isInteger(requested)
        ? Math.min(Math.max(requested, 1), totalLines)
        : Math.max(1, (excerptLine ?? 1) - LEAD_IN_LINES);

      // Reserve room for the JSON envelope around the numbered lines.
      const textBudget = Math.max(0, Math.floor(maxChars) - 400);
      const lines = [];
      let used = 0;
      let endLine = startLine - 1;
      for (let line = startLine; line <= totalLines; line += 1) {
        const text = `${line}: ${String(sentences[line - 1] || '').trim()}`;
        const cost = text.length + (lines.length ? 1 : 0);
        if (used + cost > textBudget) {
          // Always return at least part of one line so a reader can progress.
          if (!lines.length && textBudget > 0) {
            lines.push(text.slice(0, textBudget));
            endLine = line;
          }
          break;
        }
        lines.push(text);
        used += cost;
        endLine = line;
      }
      if (!lines.length) throw new Error('no context budget is left to read more of the page');
      return JSON.stringify({
        kind: 'page_text',
        note: 'Page line numbers are not excerpt line numbers; highlight_span accepts excerpt lines only.',
        totalLines,
        ...(excerptLine ? { excerptStartsAtLine: excerptLine } : {}),
        startLine,
        endLine,
        ...(endLine < totalLines ? { nextStartLine: endLine + 1 } : {}),
        ...(page.truncated ? { truncated: true } : {}),
        numberedText: lines.join('\n'),
      });
    },
  };
}
