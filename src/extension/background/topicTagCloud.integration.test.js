import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { MSG } from '../../shared/runtime/messages.js';
import { createChromeStorageFake } from '../../../test/fakes/chromeStorageFake.mjs';

// Exercises the actual browser messenger, worker listener, storage, provider
// configuration and DecisionClient transport together, without an external model.
it('generates and reopens cached tags through the worker within the configured request limit', async () => {
  vi.resetModules();
  const fake = createChromeStorageFake();
  let onMessage;
  const runtime = Object.assign(fake.runtime, {
    id: 'test-id',
    getURL: (path = '') => `chrome-extension://test-id/${path}`,
    getPlatformInfo: async () => ({}),
    onMessage: {
      addListener: (listener) => {
        onMessage = listener;
      },
    },
    onStartup: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    sendMessage: (message, callback) =>
      onMessage(message, { id: 'test-id', url: 'chrome-extension://test-id/popup.html' }, callback),
  });
  vi.stubGlobal('chrome', {
    runtime,
    storage: {
      local: fake.storage.local,
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(),
      clear: vi.fn(),
      get: vi.fn((_name, cb) => cb(undefined)),
      onAlarm: { addListener: vi.fn() },
    },
    action: { setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn(), setIcon: vi.fn() },
  });
  const requests = [];
  let inFlight = 0;
  let peakInFlight = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, options) => {
      const body = JSON.parse(options.body);
      requests.push({ url, options, body });
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await setImmediate();
      inFlight--;
      return new Response(
        JSON.stringify({
          answers: Object.fromEntries(
            Object.entries(body.questions).map(([id, question]) => [
              id,
              {
                probabilities: {
                  yes: /^(Coral|Reefs)$/i.test(question.instructions.word) ? 0.9 : 0.1,
                  no: 0.1,
                },
              },
            ]),
          ),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }),
  );
  const { writeRecord } = await import('../../core/storage/storage.js');
  const { saveProvider, setTopicSplitter } = await import('../../core/llm/providers.js');
  const { setStoredMaxParallelLlmRequests } = await import('../../core/settings/llmConcurrency.js');
  await setStoredMaxParallelLlmRequests(1);
  await writeRecord({
    key: 'article',
    sourceUrl: 'https://example.com',
    status: 'done',
    contentRevision: 'content-1',
    topicsRevision: 'topics-1',
    pipelineRunId: 'run-1',
    sentences: ['Coral reefs support marine life.', 'Salmon migrate upstream.'],
    topics: [
      { name: 'Ocean > Habitats', sentences: [1] },
      { name: 'Rivers > Fish', sentences: [2] },
    ],
    topic_summaries: {},
    topic_summary_index: {},
    processingLog: [],
    createdAt: 1,
    updatedAt: 1,
  });
  await saveProvider({
    id: 'decision',
    name: 'Local Decisions',
    type: 'llama_decision',
    url: 'http://localhost:8080',
    model: 'mock-model',
  });
  await saveProvider({
    id: 'splitter',
    name: 'Topic splitter',
    type: 'llama_decision',
    url: 'http://localhost:8081',
  });
  await setTopicSplitter('splitter');
  const worker = await import('./background.js');
  await worker.backgroundReady;
  const { browserRecordSource } = await import('../../canvas/recordSource.js');
  await expect(browserRecordSource.getTopicTagClouds('article', 'pipeline')).rejects.toThrow(
    'Select a Decisions provider under Topic tag clouds',
  );
  expect(requests).toHaveLength(0);
  const assignment = await new Promise((resolve) =>
    runtime.sendMessage({ type: MSG.setTagCloudProvider, id: 'decision' }, resolve),
  );
  expect(assignment).toMatchObject({
    ok: true,
    splitterId: 'splitter',
    tagCloudProviderId: 'decision',
  });
  const generated = await browserRecordSource.getTopicTagClouds('article', 'pipeline');
  expect(generated.byPath['Ocean>Habitats']).toEqual([
    { word: 'Coral', weight: 0.9 },
    { word: 'reefs', weight: 0.9 },
  ]);
  expect(generated.byPath.Ocean).toEqual(generated.byPath['Ocean>Habitats']);
  expect(requests).toHaveLength(2);
  expect(peakInFlight).toBe(1);
  expect(requests[0].url).toBe('http://localhost:8080/v1/systemone');
  expect(requests[0].body.model).toBe('mock-model');
  expect(requests[0].body.state.topic_title).toBe('Ocean>Habitats');
  const requestCount = requests.length;
  const reopenedRecord = await browserRecordSource.fetch('article');
  expect(reopenedRecord.record.topic_tag_clouds.pipeline).toEqual(generated);
  const reopened = await browserRecordSource.getTopicTagClouds('article', 'pipeline');
  expect(reopened).toEqual(generated);
  expect(requests).toHaveLength(requestCount);
});

afterEach(() => {
  vi.unstubAllGlobals();
});
