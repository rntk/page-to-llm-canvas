import { describe, it, expect, vi } from 'vitest';
import { guardTrustedUserEvent, isTrustedUserEvent } from './eventSecurity.js';

function eventWithTrust(isTrusted) {
  return {
    isTrusted,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

describe('content event security', () => {
  it('accepts trusted user events', () => {
    expect(isTrustedUserEvent(eventWithTrust(true), { allowSynthetic: false })).toBe(true);
  });

  it('rejects synthetic events outside test mode', () => {
    const event = eventWithTrust(false);

    expect(guardTrustedUserEvent(event, { allowSynthetic: false })).toBe(false);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
  });
});
