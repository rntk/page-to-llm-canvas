/**
 * Structural sharing for plain JSON-like data: returns `next`, but with every
 * part that deep-equals the matching part of `prev` replaced by the `prev`
 * object. Unchanged data therefore keeps its identity across refetches, so
 * consumers can memoize on plain object dependencies.
 *
 * @template T
 * @param {*} prev
 * @param {T} next
 * @returns {T}
 */
export function shareEqual(prev, next) {
  if (Object.is(prev, next)) return prev;
  if (Array.isArray(prev) && Array.isArray(next)) {
    let same = prev.length === next.length;
    const out = next.map((item, index) => {
      const shared = shareEqual(prev[index], item);
      if (shared !== prev[index]) same = false;
      return shared;
    });
    return same ? prev : out;
  }
  if (isPlainObject(prev) && isPlainObject(next)) {
    const prevKeys = Object.keys(prev);
    const nextKeys = Object.keys(next);
    let same = prevKeys.length === nextKeys.length;
    const out = {};
    for (const key of nextKeys) {
      const shared = shareEqual(prev[key], next[key]);
      if (!Object.hasOwn(prev, key) || shared !== prev[key]) same = false;
      out[key] = shared;
    }
    return same ? prev : out;
  }
  return next;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
