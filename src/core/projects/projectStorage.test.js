import { describe, it, expect, vi } from 'vitest';
import { createProjectStore, normalizeStoredProjects } from './projectStorage.js';

function memoryStore(initial) {
  const data = { k: initial };
  return {
    data,
    get: vi.fn(async (key) => ({ [key]: data[key] })),
    set: vi.fn(async (items) => Object.assign(data, items)),
    queue: (_key, fn) => fn(),
    key: 'k',
  };
}

describe('project storage', () => {
  it('drops invalid and duplicate entries on read', () => {
    expect(normalizeStoredProjects('nope')).toEqual([]);
    expect(normalizeStoredProjects([{ id: 'a' }, { id: 'a' }, null]).map((p) => p.id)).toEqual([
      'a',
    ]);
  });

  it('lists, gets, and updates through the adapter', async () => {
    const deps = memoryStore([{ id: 'a', title: 'A' }]);
    const store = createProjectStore(deps);
    expect((await store.get('a')).title).toBe('A');
    expect(await store.get('missing')).toBeNull();
    const next = await store.update((list) => [
      ...list,
      { id: 'b', title: 'B', color: '', groupId: null, createdAt: 0, updatedAt: 0 },
    ]);
    expect(next.map((p) => p.id)).toEqual(['a', 'b']);
    expect(deps.data.k).toHaveLength(2);
  });

  it('skips the write when the mutator returns null', async () => {
    const deps = memoryStore([]);
    await createProjectStore(deps).update(() => null);
    expect(deps.set).not.toHaveBeenCalled();
  });
});
