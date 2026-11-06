import React, { useCallback, useState } from 'react';
import { browserProjectsApi, subscribeProjectChanges } from '../projects/projectsApi.js';
import { useProjectsOverview } from './useProjectsOverview.js';

// Chrome tab group colors mapped to approximations of the browser's own chips.
const GROUP_COLORS = {
  grey: '#5f6368',
  blue: '#1a73e8',
  red: '#d93025',
  yellow: '#f9ab00',
  green: '#1e8e3e',
  pink: '#d01884',
  purple: '#9334e6',
  cyan: '#007b83',
  orange: '#e8710a',
};

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleString();
}

function tabCountLabel(count) {
  const tabs = Number.isFinite(count) ? count : 0;
  return `${tabs} ${tabs === 1 ? 'tab' : 'tabs'}`;
}

function ColorChip({ color }) {
  const name = GROUP_COLORS[color] ? color : 'grey';
  return (
    <span
      className="project-color-chip"
      style={{ backgroundColor: GROUP_COLORS[name] }}
      title={`${name} group`}
      role="img"
      aria-label={`${name} group`}
    />
  );
}

/**
 * Lists projects (browser tab groups with a canvas) and live tab groups that do
 * not have a project yet.
 *
 * @param {{
 *   pageHost: {confirm: function(string): boolean},
 *   projectsApi?: object,
 *   subscribeProjects?: function(function(): void): function(): void,
 * }} props Injected capabilities; defaults are browser-backed.
 */
export function ProjectsSection({
  pageHost,
  projectsApi = browserProjectsApi,
  subscribeProjects = subscribeProjectChanges,
}) {
  const [busyKeys, setBusyKeys] = useState(() => new Set());
  const [actionError, setActionError] = useState('');
  const { overview, isLoading, loadError, reload } = useProjectsOverview({
    listOverview: projectsApi.listProjectsOverview,
    subscribe: subscribeProjects,
  });
  const { projects, ungroupedGroups } = overview;

  const runAction = useCallback(
    async (busyKey, action, { refresh = false } = {}) => {
      if (busyKeys.has(busyKey)) return;
      setActionError('');
      setBusyKeys((prev) => new Set(prev).add(busyKey));
      try {
        await action();
        if (refresh) await reload();
      } catch (caughtError) {
        setActionError(caughtError?.message || 'Project action failed');
      } finally {
        setBusyKeys((prev) => {
          const next = new Set(prev);
          next.delete(busyKey);
          return next;
        });
      }
    },
    [busyKeys, reload],
  );

  const deleteProject = (project) => {
    const name = project.title || 'Untitled project';
    if (
      !pageHost.confirm(
        `Delete project "${name}"? This only removes the project; its tabs and tab group stay open.`,
      )
    )
      return;
    void runAction(`project:${project.id}`, () => projectsApi.deleteProject(project.id), {
      refresh: true,
    });
  };

  return (
    <>
      <h2>Projects</h2>
      <div className="note note--stacked">
        A project is a browser tab group. Open a project to see its tabs on a canvas. Tip:
        right-click a page or the extension icon → &lsquo;Open group project&rsquo;, or press
        Alt+Shift+P.
      </div>

      {actionError ? <div className="form-error form-error--stacked">{actionError}</div> : null}
      {loadError ? (
        <div className="form-error form-error--stacked">
          {loadError}{' '}
          <button type="button" onClick={() => void reload()}>
            Retry
          </button>
        </div>
      ) : null}

      <h3 className="projects-subheading">Your projects</h3>
      {isLoading ? (
        <div className="empty">Loading projects...</div>
      ) : projects.length === 0 ? (
        <div className="empty">No projects yet — create one from a tab group below.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Project</th>
              <th>Status</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const busy = busyKeys.has(`project:${project.id}`);
              return (
                <tr key={project.id}>
                  <td>
                    <div className="project-title">
                      <ColorChip color={project.color} />
                      <span>{project.title || 'Untitled project'}</span>
                    </div>
                  </td>
                  <td>
                    {project.isOpen ? (
                      <>
                        <span className="status done">Open</span>
                        <div className="note">{tabCountLabel(project.tabCount)}</div>
                      </>
                    ) : (
                      <span className="status">Closed</span>
                    )}
                  </td>
                  <td>{formatDate(project.createdAt)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(`project:${project.id}`, () =>
                            projectsApi.openProject(project.id),
                          )
                        }
                      >
                        Open
                      </button>
                      <button
                        type="button"
                        disabled={busy || !project.isOpen}
                        title={project.isOpen ? undefined : 'The project’s tab group is closed'}
                        onClick={() =>
                          void runAction(`project:${project.id}`, () =>
                            projectsApi.focusGroup(project.id),
                          )
                        }
                      >
                        Focus group
                      </button>
                      <button
                        className="danger"
                        type="button"
                        disabled={busy}
                        title="Removes the project only; never closes tabs"
                        onClick={() => deleteProject(project)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}

      <h3 className="projects-subheading">Tab groups without a project</h3>
      {isLoading ? null : ungroupedGroups.length === 0 ? (
        <div className="empty">
          No open tab groups. Group some tabs in your browser to start a project.
        </div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Tab group</th>
              <th>Tabs</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {ungroupedGroups.map((group) => {
              const busy = busyKeys.has(`group:${group.groupId}`);
              return (
                <tr key={group.groupId}>
                  <td>
                    <div className="project-title">
                      <ColorChip color={group.color} />
                      <span>{group.title || 'Untitled group'}</span>
                    </div>
                  </td>
                  <td>{tabCountLabel(group.tabCount)}</td>
                  <td>
                    <div className="row-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(
                            `group:${group.groupId}`,
                            () => projectsApi.openProjectForGroup(group.groupId),
                            { refresh: true },
                          )
                        }
                      >
                        Create &amp; open project
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void runAction(
                            `group:${group.groupId}`,
                            () => projectsApi.createProjectFromGroup(group.groupId),
                            { refresh: true },
                          )
                        }
                      >
                        Create project
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
