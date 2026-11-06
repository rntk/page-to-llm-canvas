import { describe, it, expect } from 'vitest';
import {
  buildProjectPageUrl,
  createProjectFromGroup,
  indexProjectTabs,
  normalizeProject,
  parseProjectIdFromUrl,
  rebindProjects,
  unbindGroup,
} from './projects.js';

const BASE = 'chrome-extension://ext/project.html';
const project = (id, fields = {}) => ({
  id,
  title: fields.title ?? id,
  color: fields.color ?? 'blue',
  groupId: fields.groupId ?? null,
  createdAt: 1,
  updatedAt: 1,
});
const group = (id, title, color = 'blue', windowId = 1) => ({ id, title, color, windowId });
const tab = (id, groupId, url = `https://example.com/${id}`) => ({ id, groupId, url, index: id });
const projectTab = (id, groupId, projectId) =>
  tab(id, groupId, buildProjectPageUrl(BASE, projectId));

describe('project page URLs', () => {
  it('round-trips ids through the page URL', () => {
    const url = buildProjectPageUrl(BASE, 'a b&c');
    expect(url).toBe(`${BASE}?id=a%20b%26c`);
    expect(parseProjectIdFromUrl(url, BASE)).toBe('a b&c');
  });

  it('rejects other pages, origins, and missing ids', () => {
    expect(parseProjectIdFromUrl('chrome-extension://ext/options.html?id=a', BASE)).toBeNull();
    expect(parseProjectIdFromUrl('chrome-extension://other/project.html?id=a', BASE)).toBeNull();
    expect(parseProjectIdFromUrl(`${BASE}`, BASE)).toBeNull();
    expect(parseProjectIdFromUrl('not a url', BASE)).toBeNull();
    expect(parseProjectIdFromUrl(undefined, BASE)).toBeNull();
  });

  it('indexes project tabs by id, including pending URLs', () => {
    const pending = { id: 9, groupId: 2, pendingUrl: buildProjectPageUrl(BASE, 'p2') };
    const index = indexProjectTabs([projectTab(1, 1, 'p1'), tab(2, 1), pending], BASE);
    expect([...index.keys()]).toEqual(['p1', 'p2']);
    expect(index.get('p2')).toEqual([pending]);
  });
});

describe('project shape', () => {
  it('creates a project bound to its group', () => {
    expect(createProjectFromGroup(group(5, 'Work', 'red'), { id: 'p', now: 10 })).toEqual({
      id: 'p',
      title: 'Work',
      color: 'red',
      groupId: 5,
      createdAt: 10,
      updatedAt: 10,
    });
  });

  it('normalizes stored values', () => {
    expect(normalizeProject(null)).toBeNull();
    expect(normalizeProject({ id: '' })).toBeNull();
    expect(normalizeProject({ id: 'x', groupId: -1, createdAt: 3 })).toEqual({
      id: 'x',
      title: '',
      color: '',
      groupId: null,
      createdAt: 3,
      updatedAt: 3,
    });
  });
});

describe('rebindProjects', () => {
  const rebind = (projects, groups, tabs, trustCached = true) =>
    rebindProjects(projects, groups, tabs, { pageBaseUrl: BASE, now: 99, trustCached });

  it('binds to the group containing the project tab (anchor) over a stale cache', () => {
    const result = rebind(
      [project('p1', { groupId: 7, title: 'Old' })],
      [group(7, 'Other'), group(42, 'Work')],
      [projectTab(1, 42, 'p1')],
    );
    expect(result.changed).toBe(true);
    expect(result.projects[0]).toMatchObject({ groupId: 42, title: 'Work', updatedAt: 99 });
  });

  it('keeps a live cached groupId only when trusted', () => {
    const projects = [project('p1', { groupId: 3, title: 'A' })];
    const groups = [group(3, 'B', 'red')];
    expect(rebind(projects, groups, []).projects[0]).toMatchObject({
      groupId: 3,
      title: 'B',
      color: 'red',
    });
    expect(rebind(projects, groups, [], false).projects[0].groupId).toBeNull();
  });

  it('returns the same objects and changed=false when nothing moved', () => {
    const projects = [project('p1', { groupId: 3, title: 'A' })];
    const result = rebind(projects, [group(3, 'A')], []);
    expect(result.changed).toBe(false);
    expect(result.projects[0]).toBe(projects[0]);
  });

  it('falls back to a unique title + color match', () => {
    const result = rebind(
      [project('p1', { title: 'Work' })],
      [group(8, 'Work'), group(9, 'Work', 'red')],
      [],
      false,
    );
    expect(result.projects[0].groupId).toBe(8);
  });

  it('skips ambiguous or untitled fallback matches', () => {
    expect(
      rebind([project('p1', { title: 'W' })], [group(1, 'W'), group(2, 'W')], []).projects[0]
        .groupId,
    ).toBeNull();
    expect(
      rebind(
        [project('p1', { title: 'W' }), project('p2', { title: 'W' })],
        [group(1, 'W')],
        [],
      ).projects.map((p) => p.groupId),
    ).toEqual([null, null]);
    expect(
      rebind([project('p1', { title: '' })], [group(1, '')], []).projects[0].groupId,
    ).toBeNull();
  });

  it('never binds one group to two projects', () => {
    const result = rebind(
      [project('p1', { groupId: 5 }), project('p2', { groupId: 5 })],
      [group(5, 'G')],
      [projectTab(1, 5, 'p2')],
    );
    expect(result.projects.map((p) => p.groupId)).toEqual([null, 5]);
  });

  it('ignores ungrouped project tabs and unknown project ids', () => {
    const result = rebind(
      [project('p1', { title: 'x' })],
      [group(5, 'G')],
      [projectTab(1, -1, 'p1'), projectTab(2, 5, 'nope')],
    );
    expect(result.projects[0].groupId).toBeNull();
  });

  it('keeps the remembered title when the group is untitled', () => {
    const result = rebind(
      [project('p1', { title: 'Keep' })],
      [group(5, '')],
      [projectTab(1, 5, 'p1')],
    );
    expect(result.projects[0]).toMatchObject({ groupId: 5, title: 'Keep' });
  });
});

describe('unbindGroup', () => {
  it('unbinds only the matching project', () => {
    const result = unbindGroup([project('a', { groupId: 1 }), project('b', { groupId: 2 })], 1, 5);
    expect(result.changed).toBe(true);
    expect(result.projects.map((p) => p.groupId)).toEqual([null, 2]);
    expect(unbindGroup(result.projects, 9, 5).changed).toBe(false);
  });
});
