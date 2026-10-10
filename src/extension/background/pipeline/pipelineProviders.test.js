import { describe, expect, it, vi } from 'vitest';
import { createPipelineProviderServices } from './pipelineProviders.js';
import { makeRuntime } from '../../../../test/fakes/pipelineFixtures.mjs';
import { LLM_TASK_TYPES } from '../../../core/metrics/llm.js';

const completionProvider = {
  id: 'completion',
  type: 'openai_comp',
  model: 'completion-model',
  url: 'https://models.example/v1/',
};
const decisionProvider = {
  id: 'decisions',
  name: 'Decisions',
  type: 'llama_decision',
  model: 'decision-model',
  url: 'https://models.example/',
};

function setup() {
  const decide = vi.fn(async (_state, questions) => ({
    answers: Object.fromEntries(
      Object.keys(questions).map((id) => [
        id,
        { choice: 'continue', probabilities: { split: 0, continue: 1 } },
      ]),
    ),
  }));
  const llm = {
    callLLMWithRetry: vi.fn(async () => '1: Science'),
    createDecisionClient: vi.fn(() => ({ decide })),
  };
  const limiter = { run: vi.fn((fn) => fn()) };
  const telemetry = {
    wrapCallLLMWithRetry: vi.fn((call) => call),
    wrapDecide: vi.fn((call) => call),
  };
  const providerRepository = { getDecisionProvider: vi.fn(async () => decisionProvider) };
  const bind = createPipelineProviderServices({ providerRepository, llm, telemetry, limiter });
  return { bind, llm, decide, limiter, telemetry, providerRepository };
}

async function split(services, record = {}) {
  let checkpoint;
  const runtime = makeRuntime({
    ...services.runtimeOptions,
    update: vi.fn(async (patch) => {
      if (patch.topic_range_chunks) checkpoint = structuredClone(patch.topic_range_chunks);
    }),
  });
  const splitter = await services.resolveTopicSplitter();
  const groups = await splitter.split({
    runtime,
    record: { contentRevision: 'revision', ...record },
    text: 'First. Second.',
    sentenceObjs: [{ text: 'First.' }, { text: 'Second.' }],
    sentenceTexts: ['First.', 'Second.'],
  });
  return { groups, checkpoint };
}

describe('pipeline provider composition', () => {
  it('schedules and measures both APIs with the same server and record identities', async () => {
    const { bind, llm, decide, limiter, telemetry } = setup();
    const services = bind({
      activeProvider: completionProvider,
      key: 'article',
      verboseLogs: true,
    });
    expect(llm.createDecisionClient).not.toHaveBeenCalled();

    const { groups } = await split(services);

    expect(groups).toEqual([{ label: ['Science'], ranges: [{ start: 0, end: 1 }] }]);
    expect(limiter.run).toHaveBeenCalledTimes(2);
    for (const [, signal, keys] of limiter.run.mock.calls) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(keys).toEqual({ providerKey: 'https://models.example', fairnessKey: 'article' });
    }
    expect(telemetry.wrapDecide).toHaveBeenCalledWith(expect.any(Function), {
      provider: 'llama_decision',
      model: 'decision-model',
    });
    expect(decide).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      expect.objectContaining({ verboseLogs: true }),
    );
    expect(llm.callLLMWithRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: completionProvider,
        taskType: LLM_TASK_TYPES.TOPIC_LABELS,
      }),
      expect.any(Number),
    );
  });

  it('selects completion splitting without constructing a decision client', async () => {
    const { bind, llm, providerRepository } = setup();
    providerRepository.getDecisionProvider.mockResolvedValueOnce(null);
    const splitter = await bind({
      activeProvider: completionProvider,
      key: 'a',
    }).resolveTopicSplitter();
    expect(splitter.diagnostics).toEqual({ topicSplitter: 'llm' });
    expect(llm.createDecisionClient).not.toHaveBeenCalled();
  });

  it('describes the selected decision splitter for pipeline logs', async () => {
    const { bind } = setup();
    const splitter = await bind({
      activeProvider: completionProvider,
      key: 'a',
    }).resolveTopicSplitter();
    expect(splitter.diagnostics).toEqual({
      topicSplitter: 'decision',
      decisionProvider: 'Decisions',
      decisionModel: 'decision-model',
    });
  });

  it('pins completion dispatch to each run even when requests supply another provider', async () => {
    const { bind, llm } = setup();
    const first = bind({ activeProvider: completionProvider, key: 'first' });
    const nextProvider = { ...completionProvider, model: 'next-model' };
    const second = bind({ activeProvider: nextProvider, key: 'second' });
    await second.callLLMWithRetry({ prompt: 'Second' }, 2);
    await first.callLLMWithRetry({ prompt: 'First', provider: nextProvider }, 1);
    expect(llm.callLLMWithRetry.mock.calls.map(([opts]) => opts.provider)).toEqual([
      nextProvider,
      completionProvider,
    ]);
  });

  it('reuses matching decision work and invalidates it when the labeling provider changes', async () => {
    const { bind, llm, decide } = setup();
    const services = bind({ activeProvider: completionProvider, key: 'article' });
    const { checkpoint } = await split(services);
    llm.callLLMWithRetry.mockClear();
    decide.mockClear();
    await split(services, { topic_range_chunks: checkpoint });
    expect(decide).not.toHaveBeenCalled();
    expect(llm.callLLMWithRetry).not.toHaveBeenCalled();

    const changed = bind({
      activeProvider: { ...completionProvider, model: 'new-label-model' },
      key: 'article',
    });
    await split(changed, { topic_range_chunks: checkpoint });
    expect(decide).toHaveBeenCalledTimes(1);
    expect(llm.callLLMWithRetry).toHaveBeenCalledTimes(1);
  });
});
