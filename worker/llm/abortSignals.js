// Abort/timeout plumbing shared by the LLM boundary and its concurrency
// limiters. Nothing here is provider-specific; it only speaks AbortSignal.

export const defaultScheduler = Object.freeze({
  setTimeout: (...args) => globalThis.setTimeout(...args),
  clearTimeout: (timeoutId) => globalThis.clearTimeout(timeoutId),
});

export function makeAbortError(message) {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}

export function isAbortRejection(error, signal) {
  if (!signal?.aborted) return false;
  const reason = signal.reason;
  const seen = new Set();
  let current = error;
  while (current && (typeof current === 'object' || typeof current === 'function')) {
    if (seen.has(current)) break;
    seen.add(current);
    if (current.name === 'AbortError' || current.code === 'ABORT_ERR') return true;
    if (reason !== undefined && current === reason) return true;
    current = current.cause;
  }
  return false;
}

export function mergeAbortSignals(...signals) {
  const activeSignals = signals.filter(Boolean);
  if (activeSignals.length === 0) return { signal: undefined, dispose() {} };
  if (activeSignals.length === 1) return { signal: activeSignals[0], dispose() {} };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.any === 'function') {
    return { signal: AbortSignal.any(activeSignals), dispose() {} };
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  const listenedSignals = [];
  for (const signal of activeSignals) {
    if (signal.aborted) {
      abort();
      break;
    }
    signal.addEventListener('abort', abort, { once: true });
    listenedSignals.push(signal);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of listenedSignals) {
        signal.removeEventListener('abort', abort);
      }
    },
  };
}

export function createRequestTimeoutSignal(ms, scheduler = defaultScheduler) {
  const controller = new AbortController();
  const timeoutId = scheduler.setTimeout(() => {
    controller.abort(
      typeof DOMException !== 'undefined'
        ? new DOMException('Timeout', 'TimeoutError')
        : Object.assign(new Error('Timeout'), { name: 'TimeoutError' }),
    );
  }, ms);
  return {
    signal: controller.signal,
    dispose() {
      scheduler.clearTimeout(timeoutId);
    },
  };
}

export function sleepWithAbort(ms, signal, scheduler = defaultScheduler) {
  if (!signal) {
    return new Promise((resolve) => {
      scheduler.setTimeout(resolve, ms);
    });
  }
  if (signal.aborted) {
    return Promise.reject(makeAbortError('LLM request aborted'));
  }
  return new Promise((resolve, reject) => {
    const timeoutId = scheduler.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      scheduler.clearTimeout(timeoutId);
      reject(makeAbortError('LLM request aborted'));
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
