import { describe, expect, it, vi } from 'vitest';
import { createResplitAction } from './topicResplit.js';

const SUBTOPIC = { name: 'Science>AI', sentences: [1, 2] };
const SIBLING = { name: 'History', sentences: [3] };

function createAction(overrides = {}) {
  return createResplitAction({
    topics: [SUBTOPIC, SIBLING],
    request: vi.fn(async () => ({ ok: true })),
    onAccepted: vi.fn(),
    confirm: vi.fn(() => true),
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
  it('asks for confirmation naming the consequence when subtopics overlap', async () => {
    const confirm = vi.fn(() => true);
    const request = vi.fn(async () => ({ ok: true }));
    const action = createAction({ confirm, request });
    await action.onSelect(TARGET);
    expect(confirm).toHaveBeenCalledOnce();
    expect(confirm.mock.calls[0][0]).toContain('Continue?');
    expect(request).toHaveBeenCalledWith(TARGET);
  });

  it('dismisses without requesting when confirmation is declined', async () => {
    const confirm = vi.fn(() => false);
    const request = vi.fn(async () => ({ ok: true }));
    const action = createAction({ confirm, request });
    await expect(action.onSelect(TARGET)).resolves.toEqual({ ok: true, dismissed: true });
    expect(request).not.toHaveBeenCalled();
  });

  it('skips confirmation when no subtopics overlap', async () => {
    const confirm = vi.fn(() => true);
    const request = vi.fn(async () => ({ ok: true }));
    const action = createAction({ confirm, request });
    await action.onSelect({ path: 'History', startSentence: 3, endSentence: 3 });
    expect(confirm).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalled();
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
