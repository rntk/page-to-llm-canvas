import { useState } from 'react';
import { useStaleTick } from '../shared/useStaleTick.js';
import { describeMerge } from './projectMergeState.js';

/**
 * Topic-merge commands for a project (build, stop, open) plus polling of the
 * project view while a merge is running.
 *
 * @param {object} options
 * @param {string|null} options.projectId
 * @param {import('../projects/projectsApi.js').ProjectsApi} options.api
 * @param {object|undefined} options.merge The view's `topicMerge` state.
 * @param {function(): *} options.refresh Reloads the project view.
 * @param {function(): void} options.showTopics Switches to the topics view.
 */
export function useProjectMerge({ projectId, api, merge, refresh, showTopics }) {
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');

  const run = async (request) => {
    if (pending) return;
    setPending(true);
    setNotice('');
    try {
      const response = await request();
      if (response?.ok === false) throw new Error(response.error || 'Project request failed');
    } catch (err) {
      setNotice(err?.message || String(err));
    } finally {
      refresh();
      setPending(false);
    }
  };

  const build = (options) => run(() => api.buildProjectTopicTree(projectId, options));
  const stop = () => run(() => api.stopProjectTopicTree(projectId));

  const { running, needsBuild } = describeMerge(merge);
  const open = () => {
    showTopics();
    if (needsBuild) void build({ fresh: false });
  };

  useStaleTick(running, refresh);

  const actions = [
    {
      id: 'merge-primary-topics',
      label: 'Merge similar topics',
      description:
        'Group primary topics across the project’s saved pages and read their sources together.',
      disabled: pending,
      onSelect: open,
    },
  ];

  return { pending, notice, build, stop, open, actions };
}
