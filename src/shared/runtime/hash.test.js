import { describe, expect, it } from 'vitest';
import { fnv1a } from './hash.js';
import { sentenceSetFingerprint } from '../../core/storage/keys.js';
import {
  projectRecordRevision,
  projectTopicSourceRevision,
} from '../../core/projects/projectTopicTree.js';
import { sourceSummaryUnitId } from '../../core/pipeline/sourceSummaryCache.js';

describe('stable fingerprints', () => {
  it('hashes UTF-16 code units with FNV-1a', () => {
    expect(fnv1a('')).toBe(0x811c9dc5);
    expect(fnv1a('hello')).toBe(0x4f9f2cab);
    expect(fnv1a('😀')).toBe(0xcb31c4b8);
  });

  it('preserves persisted key and revision formats', () => {
    expect(sentenceSetFingerprint([12, 1, 3, 1])).toBe('wddtnc');
    const record = { key: '😀', sentences: ['test'], topics: [] };
    expect(projectRecordRevision(record)).toBe('e2100683:3be75e9f');
    expect(projectTopicSourceRevision([record])).toBe('project-topics-v1:37b6bd35:bb7801d9');
    expect(
      sourceSummaryUnitId({
        kind: 'single',
        runSentences: [1, 3, 12],
        startSentence: 1,
        endSentence: 12,
      }),
    ).toBe(
      '{"stage":"source_summary","kind":"single","path":"","run":"8-4fd89d8a-f5775cde","start":1,"end":12}',
    );
  });
});
