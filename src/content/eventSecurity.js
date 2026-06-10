export function isTrustedUserEvent(event, { allowSynthetic = import.meta.env.MODE === 'test' } = {}) {
  if (!event) return true;
  return Boolean(event.isTrusted ?? event.nativeEvent?.isTrusted) || allowSynthetic;
}

export function guardTrustedUserEvent(event, options) {
  if (isTrustedUserEvent(event, options)) return true;
  event.preventDefault?.();
  event.stopPropagation?.();
  return false;
}
