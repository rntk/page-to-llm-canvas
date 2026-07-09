import { describe, it, expect } from 'vitest';
import {
  createEmptyProviderForm,
  normalizeProvidersResponse,
  providerToForm,
  updateProviderFormField,
  updateProviderFormType,
  dedupeImportedRecords,
  extractImportedRecords,
  isImportableRecord,
  normalizeImportedRecords,
  safeFilenamePart,
  recordActionRouting,
  actionResponseError,
  shouldWarnTokenWipe,
  actionToMessageType,
  actionConfirmPrompt,
  actionErrorMessage,
} from './optionsLogic.js';

// ---------------------------------------------------------------------------
// provider form helpers
// ---------------------------------------------------------------------------

describe('provider form helpers', () => {
  it('creates a blank provider form with the expected defaults', () => {
    expect(createEmptyProviderForm()).toEqual({
      id: '',
      name: '',
      type: 'openai',
      model: '',
      token: '',
      url: '',
      serviceTier: '',
    });
  });

  it('normalizes a provider response into a safe list shape', () => {
    expect(normalizeProvidersResponse(null)).toBeNull();
    expect(normalizeProvidersResponse({ ok: false })).toBeNull();
    expect(normalizeProvidersResponse({ ok: true })).toEqual({ providers: [], activeId: null });
    expect(
      normalizeProvidersResponse({ ok: true, providers: [{ id: 'p1' }], activeId: 'p1' }),
    ).toEqual({ providers: [{ id: 'p1' }], activeId: 'p1' });
  });

  it('builds an edit form without exposing the stored token', () => {
    expect(
      providerToForm({
        id: 'p1',
        name: 'OpenAI',
        type: 'openai',
        model: 'gpt-5.4-nano',
        token: 'secret',
        url: '',
        serviceTier: 'auto',
      }),
    ).toEqual({
      id: 'p1',
      name: 'OpenAI',
      type: 'openai',
      model: 'gpt-5.4-nano',
      token: '',
      url: '',
      serviceTier: 'auto',
    });
  });

  it('updates a single provider field without mutating the original form', () => {
    const form = createEmptyProviderForm();
    const next = updateProviderFormField(form, 'name', 'My Provider');
    expect(next).toEqual({ ...form, name: 'My Provider' });
    expect(form).toEqual(createEmptyProviderForm());
  });

  it('preserves the model when switching provider type and clears service tier', () => {
    const next = updateProviderFormType(
      { ...createEmptyProviderForm(), model: 'custom-model', serviceTier: 'priority' },
      'anthropic',
      'claude-haiku-4-5',
    );
    expect(next).toEqual({
      id: '',
      name: '',
      type: 'anthropic',
      model: 'custom-model',
      token: '',
      url: '',
      serviceTier: '',
    });
  });

  it('seeds the default model when the current form model is blank', () => {
    expect(
      updateProviderFormType(createEmptyProviderForm(), 'anthropic', 'claude-haiku-4-5'),
    ).toEqual({
      id: '',
      name: '',
      type: 'anthropic',
      model: 'claude-haiku-4-5',
      token: '',
      url: '',
      serviceTier: '',
    });
  });
});

// ---------------------------------------------------------------------------
// record helpers
// ---------------------------------------------------------------------------

describe('record helpers', () => {
  it('generates a safe filename part from arbitrary values', () => {
    expect(safeFilenamePart('page:one/two?three')).toBe('page-one-two-three');
    expect(safeFilenamePart('   ')).toBe('record');
    expect(safeFilenamePart(0)).toBe('record');
  });

  it('truncates long filename parts to 80 characters', () => {
    expect(safeFilenamePart('a'.repeat(200))).toHaveLength(80);
  });

  it('extracts imported records from supported JSON wrapper shapes', () => {
    const record = { key: 'r1', text: 'hello' };
    expect(extractImportedRecords(record)).toEqual([record]);
    expect(extractImportedRecords({ record })).toEqual([record]);
    expect(extractImportedRecords({ records: [record, null, 'bad'] })).toEqual([record]);
    expect(extractImportedRecords({ items: [record] })).toEqual([record]);
    expect(extractImportedRecords({ records: [], items: [record] })).toEqual([record]);
    expect(extractImportedRecords(null)).toEqual([]);
  });

  it('checks whether an imported record has enough data to open', () => {
    expect(isImportableRecord({ key: 'r1', html: '<p>hello</p>' })).toBe(true);
    expect(isImportableRecord({ key: 'r1', text: 'hello' })).toBe(true);
    expect(isImportableRecord({ key: 'r1', topics: [] })).toBe(true);
    expect(isImportableRecord({ key: 'r1', topic_summaries: {} })).toBe(true);
    expect(isImportableRecord({ key: 'r1', sourceUrl: 'https://example.com' })).toBe(false);
    expect(isImportableRecord({ key: '   ', text: 'hello' })).toBe(false);
  });

  it('deduplicates imported records by key with later entries winning', () => {
    expect(
      dedupeImportedRecords([
        { key: 'r1', text: 'old' },
        { key: 'r2', text: 'other' },
        { key: 'r1', text: 'new' },
        { key: 'metadata-only', sourceUrl: 'https://example.com' },
      ]),
    ).toEqual([
      { key: 'r1', text: 'new' },
      { key: 'r2', text: 'other' },
    ]);
  });

  it('normalizes imported records into viewable non-pipeline records', () => {
    const [record] = normalizeImportedRecords({
      key: ' rec1 ',
      text: 'raw text',
      topics: [{ name: 'Topic', sentences: [1] }],
      topic_summaries: { Topic: { text: 'summary' } },
      status: 'summarizing',
      error: 'still running',
      progress: { stage: 'summarizing_topics', done: 0, total: 4 },
    });

    expect(record).toEqual(
      expect.objectContaining({
        key: 'rec1',
        status: 'done',
        error: null,
        text: 'raw text',
        topics: [{ name: 'Topic', sentences: [1] }],
        topic_summaries: { Topic: { text: 'summary' } },
        progress: { stage: 'imported', done: 1, total: 1 },
      }),
    );
    expect(record.importedAt).toEqual(expect.any(Number));
  });

  it('rejects JSON payloads that do not include record content, topics, or summaries', () => {
    expect(
      normalizeImportedRecords({ key: 'metadata-only', sourceUrl: 'https://example.com' }),
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// record action routing
// ---------------------------------------------------------------------------

describe('record action routing', () => {
  it('returns the runtime message type and default error string for delete', () => {
    expect(recordActionRouting('delete')).toEqual({
      messageType: 'deleteRecord',
      errorMessage: 'Failed to delete record',
    });
  });

  it('returns null message type for open while keeping the fallback error message', () => {
    expect(recordActionRouting('open')).toEqual({
      messageType: null,
      errorMessage: 'Action failed',
    });
  });

  it('returns the runtime fallback error for message-based actions with custom response text', () => {
    expect(actionResponseError({ error: 'nope' }, 'reprocess')).toBe('nope');
  });
});

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

  it('maps generateSummaries to generateRecordSummaries', () => {
    expect(actionToMessageType('generateSummaries')).toBe('generateRecordSummaries');
  });

  it('maps stop to cancelRecordProcessing', () => {
    expect(actionToMessageType('stop')).toBe('cancelRecordProcessing');
  });

  it('maps exportData to getRecord', () => {
    expect(actionToMessageType('exportData')).toBe('getRecord');
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

  it('returns null for generateSummaries (additive, nothing overwritten)', () => {
    expect(actionConfirmPrompt('generateSummaries')).toBeNull();
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
    expect(actionErrorMessage('delete')).toBe('Failed to delete record');
  });

  it('returns appropriate message for reprocess', () => {
    expect(actionErrorMessage('reprocess')).toBe('Failed to reprocess record');
  });

  it('returns appropriate message for generateSummaries', () => {
    expect(actionErrorMessage('generateSummaries')).toBe('Failed to generate summaries');
  });

  it('returns appropriate message for stop', () => {
    expect(actionErrorMessage('stop')).toBe('Failed to stop processing record');
  });

  it('returns appropriate message for exportData', () => {
    expect(actionErrorMessage('exportData')).toBe('Failed to export record data');
  });

  it('returns a generic fallback for unknown actions', () => {
    expect(actionErrorMessage('unknownAction')).toBe('Action failed');
  });
});
