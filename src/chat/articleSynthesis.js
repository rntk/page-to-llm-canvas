import { UNTRUSTED_CONTENT_TAIL } from '../shared/runtime/promptSecurity.js';

// Each synthesis group merges at least this many findings, so every level at
// least halves its input and the merge always terminates.
export const SYNTHESIS_GROUP_MIN_SIZE = 2;
// Keep a finding recognisable even when a tiny window forces hard truncation.
const SYNTHESIS_MIN_REPLY_CHARS = 64;
const SYNTHESIS_TRUNCATION_MARKER = '…[truncated]';
// Fitting converges in one or two passes; the bound only stops a pathological
// payload from looping.
const SYNTHESIS_FIT_ATTEMPTS = 4;

/**
 * @param {string} question User question.
 * @param {object[]} chunkReplies Findings to merge.
 * @returns {Array<{role: string, content: string}>}
 */
export function buildSynthesisMessages(question, chunkReplies) {
  return [
    {
      role: 'system',
      content: `You combine findings from separate chunks of one article.
Answer the user's question directly in 1-2 short sentences. The findings may be incomplete or say that a chunk was irrelevant; reconcile them without inventing facts. Do not mention chunks, prompts, or this synthesis step. The article evidence has already been highlighted, so do not quote or restate it.

The next message is JSON data.
${UNTRUSTED_CONTENT_TAIL}`,
    },
    {
      role: 'user',
      content: JSON.stringify({
        kind: 'article_synthesis',
        question: String(question || ''),
        findings: chunkReplies.map(({ chunk, reply }) => ({
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          text: reply,
        })),
      }),
    },
  ];
}

/**
 * Characters a synthesis payload spends before any finding text: the question
 * and the JSON scaffolding are repeated in every request at every merge level,
 * so they must be reserved rather than assumed small.
 * @param {string} question User question, carried by every synthesis request.
 * @param {number} groupSize Findings the payload will hold.
 */
function synthesisOverheadChars(question, groupSize) {
  const probe = { chunk: { startLine: 1, endLine: 1 }, reply: '' };
  return buildSynthesisMessages(question, Array(groupSize).fill(probe))[1].content.length;
}

/**
 * Smallest synthesis payload this question can produce: its own overhead plus
 * the floor every merged finding is entitled to. A budget below this cannot be
 * met by trimming findings, so the turn must be rejected rather than sent.
 * @param {string} question User question.
 */
export function minimumSynthesisChars(question) {
  return (
    synthesisOverheadChars(question, SYNTHESIS_GROUP_MIN_SIZE) +
    SYNTHESIS_GROUP_MIN_SIZE * SYNTHESIS_MIN_REPLY_CHARS
  );
}

/**
 * Splits chunk findings into groups that each fit one synthesis request.
 *
 * A group is only closed once it holds SYNTHESIS_GROUP_MIN_SIZE findings, so
 * every level except its remainder at least halves the input and the merge
 * loop cannot stall — even when the arithmetic below is defeated by JSON
 * escaping or unusually wide line numbers.
 *
 * @param {string} question User question.
 * @param {object[]} replies Findings to merge.
 * @param {number} maxChars Total characters one synthesis payload may occupy.
 */
export function groupSynthesisReplies(question, replies, maxChars) {
  const capacity = Math.max(0, Math.floor(maxChars) || 0);
  const available = capacity - synthesisOverheadChars(question, SYNTHESIS_GROUP_MIN_SIZE);
  const perReplyChars = Math.max(
    SYNTHESIS_MIN_REPLY_CHARS,
    Math.floor(available / SYNTHESIS_GROUP_MIN_SIZE),
  );
  const groups = [];
  let group = [];
  for (const reply of replies) {
    const item = { ...reply, reply: truncateFinding(reply.reply, perReplyChars) };
    const candidate = [...group, item];
    const payloadChars = buildSynthesisMessages(question, candidate)[1].content.length;
    if (group.length >= SYNTHESIS_GROUP_MIN_SIZE && payloadChars > capacity) {
      groups.push(group);
      group = [item];
    } else {
      group = candidate;
    }
  }
  if (group.length) groups.push(group);
  return groups.map((entries) => fitSynthesisGroup(question, entries, capacity));
}

/**
 * Shrinks one group's findings until the payload actually fits. The per-reply
 * estimate cannot know how wide the line numbers are or how much JSON escaping
 * a finding needs, so the measured payload is the authority; a group is never
 * split to make it fit, because splitting below SYNTHESIS_GROUP_MIN_SIZE would
 * stall the merge.
 * @param {string} question User question.
 * @param {object[]} group Findings merged by one request.
 * @param {number} capacity Characters the payload may occupy.
 */
function fitSynthesisGroup(question, group, capacity) {
  let items = group;
  for (let attempt = 0; attempt < SYNTHESIS_FIT_ATTEMPTS; attempt += 1) {
    const payloadChars = buildSynthesisMessages(question, items)[1].content.length;
    if (payloadChars <= capacity) break;
    const longest = Math.max(...items.map((item) => item.reply.length));
    const target = Math.max(
      SYNTHESIS_MIN_REPLY_CHARS,
      longest - Math.ceil((payloadChars - capacity) / items.length),
    );
    // No headroom left to give back; the provider reports the overflow.
    if (target >= longest) break;
    items = items.map((item) => ({ ...item, reply: truncateFinding(item.reply, target) }));
  }
  return items;
}

/**
 * Trims one finding to its share of a synthesis payload. The marker keeps the
 * cut visible to the model, which must not present a truncated finding as a
 * complete answer.
 * @param {string} reply Finding text.
 * @param {number} maxChars Characters this finding may occupy.
 */
function truncateFinding(reply, maxChars) {
  const text = String(reply || '');
  if (text.length <= maxChars) return text;
  // The marker counts against the same budget, so a truncated finding never
  // grows the payload beyond the share it was allotted.
  return `${text.slice(0, Math.max(0, maxChars - SYNTHESIS_TRUNCATION_MARKER.length))}${SYNTHESIS_TRUNCATION_MARKER}`;
}
