import { UNTRUSTED_CONTENT_TAIL } from '../shared/runtime/promptSecurity.js';

// Each synthesis group merges at least this many findings, so every level at
// least halves its input and the merge always terminates.
export const SYNTHESIS_GROUP_MIN_SIZE = 2;
// Keep a finding recognisable even when a tiny window forces hard truncation.
const SYNTHESIS_MIN_REPLY_CHARS = 64;
const SYNTHESIS_TRUNCATION_MARKER = '…[truncated]';

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
 * Reserve repeated question and JSON overhead before finding text.
 * @param {string} question User question, carried by every synthesis request.
 * @param {number} groupSize Findings the payload will hold.
 */
function synthesisOverheadChars(question, groupSize) {
  const probe = { chunk: { startLine: 1, endLine: 1 }, reply: '' };
  return buildSynthesisMessages(question, Array(groupSize).fill(probe))[1].content.length;
}

/**
 * Minimum payload size before findings can be trimmed any further.
 * @param {string} question User question.
 */
export function minimumSynthesisChars(question) {
  return (
    synthesisOverheadChars(question, SYNTHESIS_GROUP_MIN_SIZE) +
    SYNTHESIS_GROUP_MIN_SIZE * SYNTHESIS_MIN_REPLY_CHARS
  );
}

/**
 * Group findings within the payload budget. Groups retain at least two findings
 * so each merge level makes progress, except for a carried remainder.
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
 * Trim findings to fit the measured JSON payload; splitting a pair would stall
 * the merge.
 * @param {string} question User question.
 * @param {object[]} group Findings merged by one request.
 * @param {number} capacity Characters the payload may occupy.
 */
function fitSynthesisGroup(question, group, capacity) {
  let items = group;
  while (true) {
    const payloadChars = buildSynthesisMessages(question, items)[1].content.length;
    if (payloadChars <= capacity) return items;
    const longest = Math.max(...items.map((item) => item.reply.length));
    const target = Math.max(
      SYNTHESIS_MIN_REPLY_CHARS,
      longest - Math.ceil((payloadChars - capacity) / items.length),
    );
    // Escaping and wide line numbers can exhaust the finding floor. Never
    // return a payload that exceeds the configured capacity.
    if (target >= longest) {
      throw new Error('The synthesis input exceeds the configured chat context limit.');
    }
    items = items.map((item) => ({ ...item, reply: truncateFinding(item.reply, target) }));
  }
}

/**
 * Trim a finding with a visible marker so the model knows it is incomplete.
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
