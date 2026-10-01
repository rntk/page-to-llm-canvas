// One delimiter for every untrusted payload keeps Anthropic's cache-prefix
// split unambiguous across prompts.
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
