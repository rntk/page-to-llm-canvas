import { describe, expect, it } from 'vitest';
import { decodeImportedRecords, normalizeImportedRecord } from './recordImport.js';

describe('decodeImportedRecords', () => {
  it('drops non-importable entries and dedupes by trimmed key, later entries winning', () => {
    const decoded = decodeImportedRecords(
      [
        { key: 'r1', html: '<p>old</p>' },
        { key: 'metadata-only', sourceUrl: 'https://example.com' },
        { key: 'empty-html', html: '' },
        null,
        'record',
        { key: ' r1 ', html: '<p>new</p>' },
      ],
      { now: 42 },
    );
    expect(decoded.map((record) => [record.key, record.html])).toEqual([['r1', '<p>new</p>']]);
  });

  it('accepts a single record object as the payload', () => {
    expect(decodeImportedRecords({ key: 'solo', html: '<p>x</p>' }, { now: 1 })).toHaveLength(1);
    expect(decodeImportedRecords('nope')).toEqual([]);
    expect(decodeImportedRecords(null)).toEqual([]);
  });
});

describe('normalizeImportedRecord', () => {
  it('produces a viewable, non-resumable record and stamps importedAt from the caller clock', () => {
    const record = normalizeImportedRecord(
      {
        key: ' rec1 ',
        html: '<p>x</p>',
        status: 'summarizing',
        error: 'still running',
        progress: { detail: 'kept', stage: 'summarizing_topics', done: 0, total: 4 },
        importedAt: 5,
        customField: 'kept as metadata',
      },
      { now: 99 },
    );
    expect(record).toEqual({
      key: 'rec1',
      html: '<p>x</p>',
      status: 'done',
      error: null,
      progress: { detail: 'kept', stage: 'imported', done: 1, total: 1 },
      importedAt: 99,
      customField: 'kept as metadata',
    });
  });

  it('keeps terminal statuses and their errors, and never sets runtime-owned fields', () => {
    const record = normalizeImportedRecord(
      { key: 'failed', html: '<p>x</p>', status: 'error', error: 'boom' },
      { now: 1 },
    );
    expect(record).toMatchObject({ status: 'error', error: 'boom' });
    expect(record).not.toHaveProperty('pipelineRunId');
    expect(record).not.toHaveProperty('contentRevision');
  });
});
