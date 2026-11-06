// @vitest-environment happy-dom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectsSection } from './ProjectsSection.jsx';

let container;
let root;

const OPEN_PROJECT = {
  id: 'p1',
  title: 'Research',
  color: 'blue',
  groupId: 11,
  createdAt: Date.UTC(2026, 0, 2),
  updatedAt: Date.UTC(2026, 0, 3),
  isOpen: true,
  tabCount: 3,
};
const CLOSED_PROJECT = {
  id: 'p2',
  title: '',
  color: 'unknown',
  groupId: null,
  createdAt: Date.UTC(2026, 1, 2),
  updatedAt: Date.UTC(2026, 1, 3),
  isOpen: false,
  tabCount: 0,
};
const GROUP = { groupId: 21, title: 'Reading', color: 'red', windowId: 1, tabCount: 1 };
const UNTITLED_GROUP = { groupId: 22, title: '', color: 'green', windowId: 1, tabCount: 4 };

function makeApi(overview = { projects: [], ungroupedGroups: [] }) {
  return {
    listProjectsOverview: vi.fn().mockResolvedValue(overview),
    openProject: vi.fn().mockResolvedValue({}),
    focusGroup: vi.fn().mockResolvedValue({}),
    deleteProject: vi.fn().mockResolvedValue({ deleted: true }),
    createProjectFromGroup: vi.fn().mockResolvedValue({}),
    openProjectForGroup: vi.fn().mockResolvedValue({}),
  };
}

async function mount(projectsApi, { confirm = vi.fn(() => true), subscribe } = {}) {
  const subscribeProjects = subscribe || vi.fn(() => vi.fn());
  await act(async () => {
    root.render(
      <ProjectsSection
        pageHost={{ confirm }}
        projectsApi={projectsApi}
        subscribeProjects={subscribeProjects}
      />,
    );
  });
  return { confirm, subscribeProjects };
}

function button(label, scope = container) {
  const found = Array.from(scope.querySelectorAll('button')).find(
    (candidate) => candidate.textContent.trim() === label,
  );
  if (!found) throw new Error(`No button "${label}"`);
  return found;
}

function rows(tableIndex) {
  return Array.from(container.querySelectorAll('table')[tableIndex].querySelectorAll('tbody tr'));
}

async function click(element) {
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

describe('ProjectsSection', () => {
  it('renders the heading, tip and both tables', async () => {
    await mount(
      makeApi({
        projects: [OPEN_PROJECT, CLOSED_PROJECT],
        ungroupedGroups: [GROUP, UNTITLED_GROUP],
      }),
    );

    expect(container.querySelector('h2').textContent).toBe('Projects');
    expect(container.textContent).toContain('A project is a browser tab group.');
    expect(container.textContent).toContain('Alt+Shift+P');

    const [openRow, closedRow] = rows(0);
    expect(openRow.textContent).toContain('Research');
    expect(openRow.textContent).toContain('Open');
    expect(openRow.textContent).toContain('3 tabs');
    expect(openRow.querySelector('.project-color-chip').style.backgroundColor).not.toBe('');
    expect(closedRow.textContent).toContain('Untitled project');
    expect(closedRow.textContent).toContain('Closed');
    expect(button('Focus group', openRow).disabled).toBe(false);
    expect(button('Focus group', closedRow).disabled).toBe(true);

    const [groupRow, untitledRow] = rows(1);
    expect(groupRow.textContent).toContain('Reading');
    expect(groupRow.textContent).toContain('1 tab');
    expect(groupRow.textContent).not.toContain('1 tabs');
    expect(untitledRow.textContent).toContain('Untitled group');
    expect(untitledRow.textContent).toContain('4 tabs');
  });

  it('shows empty states for no projects and no tab groups', async () => {
    await mount(makeApi());

    expect(container.querySelectorAll('table')).toHaveLength(0);
    expect(container.textContent).toContain('No projects yet — create one from a tab group below.');
    expect(container.textContent).toContain(
      'No open tab groups. Group some tabs in your browser to start a project.',
    );
  });

  it('calls the matching api for the project row actions', async () => {
    const api = makeApi({ projects: [OPEN_PROJECT], ungroupedGroups: [] });
    await mount(api);
    const [row] = rows(0);

    await click(button('Open', row));
    expect(api.openProject).toHaveBeenCalledWith('p1');
    await click(button('Focus group', row));
    expect(api.focusGroup).toHaveBeenCalledWith('p1');
  });

  it('asks for confirmation before deleting and then refreshes', async () => {
    const api = makeApi({ projects: [OPEN_PROJECT], ungroupedGroups: [] });
    const confirm = vi.fn(() => false);
    await mount(api, { confirm });

    await click(button('Delete', rows(0)[0]));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toContain('Research');
    expect(confirm.mock.calls[0][0]).toContain('stay open');
    expect(api.deleteProject).not.toHaveBeenCalled();

    confirm.mockReturnValue(true);
    api.listProjectsOverview.mockClear();
    await click(button('Delete', rows(0)[0]));
    expect(api.deleteProject).toHaveBeenCalledWith('p1');
    expect(api.listProjectsOverview).toHaveBeenCalledTimes(1);
  });

  it('creates projects from ungrouped tab groups', async () => {
    const api = makeApi({ projects: [], ungroupedGroups: [GROUP] });
    await mount(api);
    const [row] = rows(0);

    await click(button('Create & open project', row));
    expect(api.openProjectForGroup).toHaveBeenCalledWith(21);
    await click(button('Create project', row));
    expect(api.createProjectFromGroup).toHaveBeenCalledWith(21);
    expect(api.listProjectsOverview.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it('disables a row while its call is in flight', async () => {
    let finish;
    const api = makeApi({ projects: [OPEN_PROJECT, CLOSED_PROJECT], ungroupedGroups: [] });
    api.openProject.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    await mount(api);
    const [openRow, closedRow] = rows(0);

    await click(button('Open', openRow));
    expect(button('Open', openRow).disabled).toBe(true);
    expect(button('Delete', openRow).disabled).toBe(true);
    expect(button('Open', closedRow).disabled).toBe(false);

    await act(async () => finish({}));
    expect(button('Open', openRow).disabled).toBe(false);
  });

  it('shows an action error and re-enables the row', async () => {
    const api = makeApi({ projects: [OPEN_PROJECT], ungroupedGroups: [] });
    api.openProject.mockRejectedValue(new Error('Tab group is gone'));
    await mount(api);

    await click(button('Open', rows(0)[0]));
    expect(container.querySelector('.form-error').textContent).toContain('Tab group is gone');
    expect(button('Open', rows(0)[0]).disabled).toBe(false);

    api.openProject.mockResolvedValue({});
    await click(button('Open', rows(0)[0]));
    expect(container.querySelector('.form-error')).toBeNull();
  });

  it('shows a load error with a retry that recovers', async () => {
    const api = makeApi();
    api.listProjectsOverview.mockRejectedValueOnce(new Error('worker offline'));
    await mount(api);

    expect(container.querySelector('.form-error').textContent).toContain('worker offline');

    api.listProjectsOverview.mockResolvedValue({ projects: [OPEN_PROJECT], ungroupedGroups: [] });
    await click(button('Retry'));
    expect(container.querySelector('.form-error')).toBeNull();
    expect(container.textContent).toContain('Research');
  });

  it('refreshes (debounced) on a subscription change and unsubscribes on unmount', async () => {
    vi.useFakeTimers();
    const api = makeApi({ projects: [], ungroupedGroups: [] });
    const unsubscribe = vi.fn();
    let notify;
    const subscribe = vi.fn((onChange) => {
      notify = onChange;
      return unsubscribe;
    });
    await mount(api, { subscribe });
    expect(container.textContent).not.toContain('Research');

    api.listProjectsOverview.mockResolvedValue({ projects: [OPEN_PROJECT], ungroupedGroups: [] });
    notify();
    notify();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(api.listProjectsOverview).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Research');

    await act(async () => root.unmount());
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    root = createRoot(container);
  });
});
