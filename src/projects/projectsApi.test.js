import { describe, it, expect, vi } from 'vitest';
import { MSG } from '../shared/runtime/messages.js';
import { createProjectsApi, subscribeProjectChanges } from './projectsApi.js';

describe('projects api', () => {
  it('sends typed messages and strips ok from results', async () => {
    const send = vi.fn(async () => ({ ok: true, project: { id: 'a' }, isOpen: true, tabs: [] }));
    const api = createProjectsApi({ send });
    expect(await api.getProjectView('a')).toEqual({ project: { id: 'a' }, isOpen: true, tabs: [] });
    expect(send).toHaveBeenCalledWith({ type: MSG.getProjectView, projectId: 'a' });
    await api.openProjectForGroup(4);
    expect(send).toHaveBeenLastCalledWith({ type: MSG.openProjectForGroup, groupId: 4 });
    await api.focusGroup('b');
    expect(send).toHaveBeenLastCalledWith({ type: MSG.focusProjectGroup, projectId: 'b' });
    await api.buildProjectTopicTree('a', { fresh: true });
    expect(send).toHaveBeenLastCalledWith({
      type: MSG.buildProjectTopicTree,
      projectId: 'a',
      fresh: true,
    });
    await api.stopProjectTopicTree('a');
    expect(send).toHaveBeenLastCalledWith({ type: MSG.stopProjectTopicTree, projectId: 'a' });
  });

  it('rejects worker errors and empty responses', async () => {
    await expect(
      createProjectsApi({
        send: async () => ({ ok: false, error: 'nope' }),
      }).listProjectsOverview(),
    ).rejects.toThrow('nope');
    await expect(
      createProjectsApi({ send: async () => undefined }).deleteProject('a'),
    ).rejects.toThrow('Project request failed');
  });

  it('subscribes to tab and group events and unsubscribes', () => {
    const event = () => ({ addListener: vi.fn(), removeListener: vi.fn() });
    const tabs = { onUpdated: event(), onRemoved: event() };
    const tabGroups = { onUpdated: event() };
    const onChange = vi.fn();
    const unsubscribe = subscribeProjectChanges(onChange, { tabs, tabGroups });
    tabs.onUpdated.addListener.mock.calls[0][0](1, {});
    expect(onChange).toHaveBeenCalledWith();
    unsubscribe();
    expect(tabs.onRemoved.removeListener).toHaveBeenCalled();
    expect(tabGroups.onUpdated.removeListener).toHaveBeenCalled();
  });
});
