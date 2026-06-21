import { describe, it, expect } from 'vitest';
import {
  shouldWarnTokenWipe,
  actionToMessageType,
  actionConfirmPrompt,
  actionErrorMessage,
} from './optionsLogic.js';

// ---------------------------------------------------------------------------
// shouldWarnTokenWipe
// ---------------------------------------------------------------------------

describe('shouldWarnTokenWipe', () => {
  const baseProvider = { type: 'openai_comp', hasToken: true, url: 'http://old' };

  it('returns true when all conditions are met', () => {
    expect(shouldWarnTokenWipe(baseProvider, { token: '', url: 'http://new' })).toBe(true);
  });

  it('returns false when editingProvider is null', () => {
    expect(shouldWarnTokenWipe(null, { token: '', url: 'http://new' })).toBe(false);
  });

  it('returns false when provider type is not openai_comp', () => {
    expect(
      shouldWarnTokenWipe({ ...baseProvider, type: 'openai' }, { token: '', url: 'http://new' }),
    ).toBe(false);
  });

  it('returns false when provider has no stored token', () => {
    expect(
      shouldWarnTokenWipe({ ...baseProvider, hasToken: false }, { token: '', url: 'http://new' }),
    ).toBe(false);
  });

  it('returns false when a new token is supplied in the form', () => {
    expect(shouldWarnTokenWipe(baseProvider, { token: 'sk-new', url: 'http://new' })).toBe(false);
  });

  it('returns false when the URL has not changed', () => {
    expect(shouldWarnTokenWipe(baseProvider, { token: '', url: 'http://old' })).toBe(false);
  });

  it('trims whitespace from token and url before comparing', () => {
    // token with only spaces counts as blank
    expect(shouldWarnTokenWipe(baseProvider, { token: '   ', url: 'http://new' })).toBe(true);
    // url with trailing space that trims to the same value → no change
    expect(shouldWarnTokenWipe(baseProvider, { token: '', url: 'http://old ' })).toBe(false);
  });

  it('treats an undefined provider url as empty string', () => {
    const providerWithoutUrl = { type: 'openai_comp', hasToken: true };
    // changing from undefined (treated as '') to a new URL should warn
    expect(shouldWarnTokenWipe(providerWithoutUrl, { token: '', url: 'http://new' })).toBe(true);
    // keeping the URL blank → no change
    expect(shouldWarnTokenWipe(providerWithoutUrl, { token: '', url: '' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// actionToMessageType
// ---------------------------------------------------------------------------

describe('actionToMessageType', () => {
  it('maps delete to deleteRecord', () => {
    expect(actionToMessageType('delete')).toBe('deleteRecord');
  });

  it('maps reprocess to reprocessRecord', () => {
    expect(actionToMessageType('reprocess')).toBe('reprocessRecord');
  });

  it('maps stop to cancelRecordProcessing', () => {
    expect(actionToMessageType('stop')).toBe('cancelRecordProcessing');
  });

  it('maps exportMetadata to getRecord', () => {
    expect(actionToMessageType('exportMetadata')).toBe('getRecord');
  });

  it('returns null for open (no message type)', () => {
    expect(actionToMessageType('open')).toBeNull();
  });

  it('returns null for unknown actions', () => {
    expect(actionToMessageType('unknownAction')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// actionConfirmPrompt
// ---------------------------------------------------------------------------

describe('actionConfirmPrompt', () => {
  it('returns a confirm string for delete', () => {
    const prompt = actionConfirmPrompt('delete');
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Delete this record');
  });

  it('returns a confirm string for reprocess containing overwrite warning', () => {
    const prompt = actionConfirmPrompt('reprocess');
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Reprocess');
    expect(prompt).toContain('overwritten');
  });

  it('returns a confirm string for stop', () => {
    const prompt = actionConfirmPrompt('stop');
    expect(typeof prompt).toBe('string');
    expect(prompt).toContain('Stop processing');
  });

  it('returns null for open (no confirmation needed)', () => {
    expect(actionConfirmPrompt('open')).toBeNull();
  });

  it('returns null for exportMetadata (no confirmation needed)', () => {
    expect(actionConfirmPrompt('exportMetadata')).toBeNull();
  });

  it('returns null for unknown actions', () => {
    expect(actionConfirmPrompt('unknownAction')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// actionErrorMessage
// ---------------------------------------------------------------------------

describe('actionErrorMessage', () => {
  it('returns appropriate message for delete', () => {
    expect(actionErrorMessage('delete')).toContain('delete');
  });

  it('returns appropriate message for reprocess', () => {
    expect(actionErrorMessage('reprocess')).toContain('reprocess');
  });

  it('returns appropriate message for stop', () => {
    expect(actionErrorMessage('stop')).toContain('stop');
  });

  it('returns appropriate message for exportMetadata', () => {
    expect(actionErrorMessage('exportMetadata')).toContain('export');
  });

  it('returns a generic fallback for unknown actions', () => {
    expect(typeof actionErrorMessage('unknownAction')).toBe('string');
    expect(actionErrorMessage('unknownAction').length).toBeGreaterThan(0);
  });
});
