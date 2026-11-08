import { useState } from 'react';
import { SUMMARY_TREE_STATUS } from '../shared/runtime/summaryTree.js';
import { useStaleTick } from '../shared/useStaleTick.js';

const REBUILD_STATUSES = ['cancelled', 'interrupted', 'error'];

/**
 * Topic-merge commands for a project (build, stop, open) plus polling of the
 * project view while a merge is running.
 *
 * @param {object} options
 * @param {string|null} options.projectId
 * @param {object} options.api Uses `buildProjectTopicTree` / `stopProjectTopicTree`.
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

  const canMerge = typeof api.buildProjectTopicTree === 'function';
  const build = (options) => run(() => api.buildProjectTopicTree(projectId, options));
  const stop =
    typeof api.stopProjectTopicTree === 'function'
      ? () => run(() => api.stopProjectTopicTree(projectId))
      : undefined;

  const open = () => {
    showTopics();
    if (
      merge?.eligiblePages?.length !== 0 &&
      (!merge?.tree || merge?.stale === true || REBUILD_STATUSES.includes(merge?.status))
    ) {
      void build({ fresh: false });
    }
  };

  const running = merge?.status === SUMMARY_TREE_STATUS.RUNNING;
  useStaleTick(running, refresh);

  return { canMerge, pending, notice, build, stop, open };
}
