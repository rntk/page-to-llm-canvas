// Console boundary for the whole extension. Every diagnostic goes through a
// logger created here so the brand prefix lives in exactly one place instead of
// being hand-written at each call site.
//
// Two output shapes exist, both preserved from the hand-written call sites:
//   `info`/`warn`/`error` merge the message into the prefix — one string,
//   remaining arguments passed through untouched:
//     createLogger().warn('storage failed:', err)
//       -> 'PageToLLM Canvas: storage failed:', err
//     createLogger('keepalive').error('listRecords failed:', err)
//       -> 'PageToLLM Canvas keepalive listRecords failed:', err
//   `event` keeps the prefix as its own argument, for the structured
//   (stage, details) logs of the pipeline runtime and article chat:
//     createLogger('pipeline').event('cleaned', { chars: 12 })
//       -> 'PageToLLM Canvas pipeline:', 'cleaned', { chars: 12 }
//
// This module deliberately has no verbose/severity plumbing of its own: whether
// an event is worth writing stays with the caller that knows the setting
// (see verboseLogSettings.js, pipelineRuntime.log, createChatLogger).

const BRAND = 'PageToLLM Canvas';

function normalizeScope(scope) {
  return typeof scope === 'string' ? scope.trim() : '';
}

/**
 * Creates a logger for one module or subsystem.
 * @param {string} [scope] Words placed after the brand, e.g. `'keepalive'`.
 *   Omit it for the plain `'PageToLLM Canvas:'` prefix. A scope may end in `:`
 *   when the module's existing messages read that way (`'chat:'`).
 * @returns {{prefix: string, info: Function, warn: Function, error: Function,
 *   event: Function, child: Function}} Logger.
 */
export function createLogger(scope) {
  const normalized = normalizeScope(scope);
  const prefix = normalized ? `${BRAND} ${normalized}` : `${BRAND}:`;
  // `event` writes the prefix as a standalone argument, so it needs the
  // punctuation the merging methods borrow from the message.
  const eventPrefix = prefix.endsWith(':') ? prefix : `${prefix}:`;

  const write = (method, message, rest) =>
    console[method](message === undefined ? prefix : `${prefix} ${message}`, ...rest);

  return {
    prefix,
    /**
     * @param {string} message
     * @param {...unknown} rest
     */
    info: (message, ...rest) => write('info', message, rest),
    /**
     * @param {string} message
     * @param {...unknown} rest
     */
    warn: (message, ...rest) => write('warn', message, rest),
    /**
     * @param {string} message
     * @param {...unknown} rest
     */
    error: (message, ...rest) => write('error', message, rest),
    /**
     * Writes a structured stage event.
     * @param {string} stage Stage name.
     * @param {object} [details] Stage details.
     * @param {{error?: boolean}} [options] Set `error` to write via console.error.
     */
    event: (stage, details = {}, options = {}) =>
      console[options.error ? 'error' : 'info'](eventPrefix, stage, details),
    /**
     * Derives a logger with extra scope words appended.
     * @param {string} subScope Words to append to this logger's scope.
     */
    child: (subScope) => {
      const sub = normalizeScope(subScope);
      if (!sub) return createLogger(normalized);
      return createLogger(normalized ? `${normalized} ${sub}` : sub);
    },
  };
}
