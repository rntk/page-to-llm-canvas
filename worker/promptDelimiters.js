// One delimiter for every untrusted payload block. Each prompt embeds exactly
// one payload, so a per-prompt tag name carried no information the surrounding
// prose ("Source:", "Chunk summaries:", ...) did not already carry, and it made
// the Anthropic cache-prefix split depend on matching the right name out of a
// list. A single name keeps that split unambiguous.
const NAME = 'pagetollm_input';

export const PROMPT_DELIMITER = Object.freeze({
  name: NAME,
  open: `<${NAME}>`,
  close: `</${NAME}>`,
  // Payload always starts on its own line so the marker below is a single
  // constant rather than one variant per prompt.
  payloadPrefix: `<${NAME}>\n`,
  // Cache split point: everything up to and including the opening tag is the
  // static prefix; the untrusted payload is the dynamic suffix.
  boundaryMarker: `\n<${NAME}>\n`,
});
