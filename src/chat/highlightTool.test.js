import { describe, expect, it } from 'vitest';
import { createHighlightLedger } from './highlightTool.js';

describe('createHighlightLedger', () => {
  it('rejects overlaps with prior and reserved ranges, then caps the budget', () => {
    const initial = [{ startLine: 1, endLine: 2 }];
    const ledger = createHighlightLedger(initial, 2);

    expect(ledger.reserve({ startLine: 2, endLine: 3 })).toBe('overlap');
    expect(ledger.reserve({ startLine: 4, endLine: 4 })).toBe('accepted');
    expect(ledger.reserve({ startLine: 4, endLine: 5 })).toBe('overlap');
    expect(ledger.isExhausted()).toBe(false);
    expect(ledger.reserve({ startLine: 6, endLine: 6 })).toBe('accepted');
    expect(ledger.isExhausted()).toBe(true);
    expect(ledger.reserve({ startLine: 8, endLine: 8 })).toBe('exhausted');
    // Overlap is reported before exhaustion, and the input is not mutated.
    expect(ledger.reserve({ startLine: 6, endLine: 6 })).toBe('overlap');
    expect(initial).toHaveLength(1);
  });

  it('keeps ranges on different pages independent', () => {
    const ledger = createHighlightLedger([{ startLine: 1, endLine: 1, pageUrl: 'a' }], 5);
    expect(ledger.reserve({ startLine: 1, endLine: 1, pageUrl: 'b' })).toBe('accepted');
  });
});
