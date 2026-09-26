import { describe, expect, it, vi } from 'vitest';
import { applyTopicResplit } from './topicResplitApply.js';
import { runSummaries } from './summaryStage.js';
import { makeRuntime } from '../../../test/fakes/pipelineFixtures.mjs';
import { PIPELINE_STATUS } from '../../shared/runtime/contracts.js';

describe('nested resplit summary reuse', () => {
  it('summarizes new leaves while keeping an ancestor whose source run is unchanged', async () => {
    const sentences = ['old one', 'old two', 'stable'].map((marker) =>
      `${marker} ${'word '.repeat(120)}`.trim(),
    );
    const record = {
      sentences,
      topics: [
        { name: 'A>Old', sentences: [1, 2] },
        { name: 'A>Stable', sentences: [3] },
      ],
      topic_summaries: {
        'A>Old': { runs: [{ sentences: [1, 2], text: 'Old leaf.' }], source_sentences: [1, 2] },
        'A>Stable': { runs: [{ sentences: [3], text: 'Stable leaf.' }], source_sentences: [3] },
      },
      topic_summary_index: {
        A: { runs: [{ sentences: [1, 2, 3], text: 'Saved ancestor.' }] },
        'A>Old': { runs: [{ sentences: [1, 2], text: 'Old leaf.' }] },
        'A>Stable': { runs: [{ sentences: [3], text: 'Stable leaf.' }] },
      },
    };
    const applied = applyTopicResplit(record, { path: 'A>Old', startSentence: 1, endSentence: 2 }, [
      { name: 'A>NewOne', sentences: [1] },
      { name: 'A>NewTwo', sentences: [2] },
    ]);
    expect(applied).not.toBeNull();

    const runtime = makeRuntime();
    const callLLMWithRetry = vi.fn(async () => 'New leaf summary.');
    await runSummaries({
      runtime,
      topics: applied.topics,
      sentenceTexts: sentences,
      previousSummaries: applied.topic_summaries,
      previousSummaryIndex: applied.topic_summary_index,
      previousSourceSummaryUnits: applied.source_summary_units,
      callLLMWithRetry,
    });

    const finalPatch = runtime.update.mock.calls.map(([patch]) => patch).at(-1);
    expect(finalPatch.status).toBe(PIPELINE_STATUS.DONE);
    expect(finalPatch.topic_summary_index.A.runs).toEqual([
      { sentences: [1, 2, 3], text: 'Saved ancestor.' },
    ]);
    expect(finalPatch.topic_summary_index['A>NewOne'].runs[0].text).toBe('New leaf summary.');
    expect(finalPatch.topic_summary_index['A>NewTwo'].runs[0].text).toBe('New leaf summary.');
    expect(finalPatch.topic_summary_index['A>Stable'].runs[0].text).toBe('Stable leaf.');
    expect(callLLMWithRetry).toHaveBeenCalledTimes(2);
  });
});
