import { describe, expect, it, vi } from 'vitest';
import { createResplitAction } from './topicResplit.js';

const SUBTOPIC = { name: 'Science>AI', sentences: [1, 2] };
const SIBLING = { name: 'History', sentences: [3] };

function createAction(overrides = {}) {
  return createResplitAction({
    topics: [SUBTOPIC, SIBLING],
    request: vi.fn(async () => ({ ok: true })),
    onAccepted: vi.fn(),
    getInstructions: vi.fn(async () => ({})),
    ...overrides,
  });
}

const TARGET = { path: 'Science', startSentence: 1, endSentence: 2 };

describe('createResplitAction title', () => {
  it('mentions subtopics when a descendant overlaps the range', () => {
    const action = createAction();
    expect(action.title(TARGET)).toContain('within this sentence range');
  });

  it('describes a plain resplit when no descendant overlaps the range', () => {
    const action = createAction();
    expect(action.title({ path: 'History', startSentence: 3, endSentence: 3 })).not.toContain(
      'its subtopics within',
    );
  });

  it('counts sentences on the range boundaries as overlapping', () => {
    const action = createAction({
      topics: [{ name: 'Science>AI', sentences: [1, 2] }],
    });
    expect(action.title({ path: 'Science', startSentence: 1, endSentence: 1 })).toContain(
      'subtopics',
    );
    expect(action.title({ path: 'Science', startSentence: 2, endSentence: 2 })).toContain(
      'subtopics',
    );
  });

  it.each([[[1]], [[4]]])(
    'excludes a descendant whose sentences (%j) fall just outside the range',
    (sentences) => {
      const action = createAction({
        topics: [{ name: 'Science>AI', sentences }],
      });
      expect(action.title({ path: 'Science', startSentence: 2, endSentence: 3 })).not.toContain(
        'its subtopics within',
      );
    },
  );

  it('finds one overlapping descendant among non-overlapping topics', () => {
    const action = createAction({
      topics: [SIBLING, { name: 'Other', sentences: [9] }, SUBTOPIC],
    });
    expect(action.title(TARGET)).toContain('within this sentence range');
  });

  it('counts a descendant with one sentence in range as overlapping', () => {
    const action = createAction({
      topics: [{ name: 'Science>AI', sentences: [1, 9] }],
    });
    expect(action.title(TARGET)).toContain('within this sentence range');
  });

  it('treats a topic without sentences as having no overlap', () => {
    const action = createAction({
      topics: [{ name: 'Science>AI' }],
    });
    expect(action.title(TARGET)).not.toContain('its subtopics within');
  });

  it('reads topics through a getter on every call', () => {
    let current = [SIBLING];
    const action = createAction({ topics: () => current });
    expect(action.title(TARGET)).not.toContain('its subtopics within');
    current = [SUBTOPIC];
    expect(action.title(TARGET)).toContain('within this sentence range');
  });
});

describe('createResplitAction without saved topics', () => {
  it('describes a plain resplit instead of throwing', () => {
    const action = createAction({ topics: undefined });
    expect(action.title(TARGET)).not.toContain('within this sentence range');
  });
});

describe('createResplitAction onSelect', () => {
  it.each([TARGET, { path: 'History', startSentence: 3, endSentence: 3 }])(
    'opens the instructions dialog before sending %j',
    async (topic) => {
      const getInstructions = vi.fn(async () => ({
        splittingInstructions: 'Split by company.',
        summaryInstructions: 'Focus on ABC.',
      }));
      const request = vi.fn(async () => ({ ok: true }));
      const action = createAction({ getInstructions, request });
      await action.onSelect(topic);
      expect(getInstructions).toHaveBeenCalledWith({ topic, hasSubtopics: topic === TARGET });
      expect(request).toHaveBeenCalledWith({
        ...topic,
        splittingInstructions: 'Split by company.',
        summaryInstructions: 'Focus on ABC.',
      });
    },
  );

  it('dismisses without requesting when the dialog is cancelled', async () => {
    const request = vi.fn();
    const onAccepted = vi.fn();
    const action = createAction({ getInstructions: async () => null, request, onAccepted });
    await expect(action.onSelect(TARGET)).resolves.toEqual({ ok: true, dismissed: true });
    expect(request).not.toHaveBeenCalled();
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('notifies acceptance with the response and topic', async () => {
    const onAccepted = vi.fn();
    const response = { ok: true };
    const action = createAction({ onAccepted, request: vi.fn(async () => response) });
    await expect(
      action.onSelect({ path: 'History', startSentence: 3, endSentence: 3 }),
    ).resolves.toBe(response);
    expect(onAccepted).toHaveBeenCalledWith(response, {
      path: 'History',
      startSentence: 3,
      endSentence: 3,
    });
  });

  it('accepts an ok response without an acceptance callback', async () => {
    const response = { ok: true };
    const action = createAction({ onAccepted: undefined, request: vi.fn(async () => response) });
    await expect(
      action.onSelect({ path: 'History', startSentence: 3, endSentence: 3 }),
    ).resolves.toBe(response);
  });

  it('does not accept a stale ok response', async () => {
    const onAccepted = vi.fn();
    const response = { ok: true, stale: true };
    const action = createAction({ onAccepted, request: vi.fn(async () => response) });
    await expect(
      action.onSelect({ path: 'History', startSentence: 3, endSentence: 3 }),
    ).resolves.toBe(response);
    expect(onAccepted).not.toHaveBeenCalled();
  });

  it('passes an empty response through without throwing', async () => {
    const onAccepted = vi.fn();
    const action = createAction({ onAccepted, request: vi.fn(async () => undefined) });
    await expect(
      action.onSelect({ path: 'History', startSentence: 3, endSentence: 3 }),
    ).resolves.toBeUndefined();
    expect(onAccepted).not.toHaveBeenCalled();
  });
});
