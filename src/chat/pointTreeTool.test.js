import { afterEach, describe, expect, it, vi } from 'vitest';
import { pointTreeTools, registerPointTree } from './pointTreeTool.js';

const cleanups = [];
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
});

function register(
  nodes = [
    { key: 'root', title: 'Root', path: 'Root', summary: 'Overview' },
    { key: 'child', title: 'Child', path: 'Root / Child', summary: 'Details' },
  ],
) {
  const view = { nodes, point: vi.fn() };
  cleanups.push(registerPointTree(view));
  return view;
}

describe('pointTreeTools', () => {
  it('requires an explicit @point mention', () => {
    expect(pointTreeTools('point to this')).toEqual([]);
    expect(pointTreeTools('email@point.example')).toEqual([]);
    expect(pointTreeTools('Please @POINT here')).toHaveLength(1);
  });

  it('discovers and filters nodes, with pagination', async () => {
    register();
    const { run } = pointTreeTools('@point')[0];
    const filtered = await run({ query: 'details' });
    expect(filtered).toContain('"key":"child"');
    expect(filtered).not.toContain('"key":"root"');
    expect(filtered).toContain('Matched 1 nodes. End.');
    const page = await run({ offset: 1 });
    expect(page).toContain('"key":"child"');
    expect(page).not.toContain('"key":"root"');
    expect(page).toContain('Matched 2 nodes. End.');
  });

  it('reports when the response budget cannot fit a node', async () => {
    register();
    await expect(pointTreeTools('@point')[0].run({}, { maxChars: 100 })).rejects.toThrow(
      'budget is too small',
    );
  });

  it('reveals an exact known node', async () => {
    const view = register();
    const { run } = pointTreeTools('@point')[0];
    await expect(run({ nodeKey: 'child' })).resolves.toContain('child');
    expect(view.point).toHaveBeenCalledWith('child');
  });

  it('rejects unknown node keys without revealing anything', async () => {
    const view = register();
    const { run } = pointTreeTools('@point')[0];
    await expect(run({ nodeKey: 'missing' })).rejects.toThrow('Unknown node key');
    expect(view.point).not.toHaveBeenCalled();
  });

  it('does not use a stale registration or select among multiple views', async () => {
    const view = register();
    const { run } = pointTreeTools('@point')[0];
    cleanups.pop()();
    register();
    await expect(run({ nodeKey: 'child' })).resolves.toContain('Tree unavailable');
    expect(view.point).not.toHaveBeenCalled();
    register();
    await expect(pointTreeTools('@point')[0].run()).resolves.toContain('Tree unavailable');
  });
});
