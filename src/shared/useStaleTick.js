import { useEffect } from 'react';
import { SUMMARY_TREE_STALE_MS } from './runtime/summaryTree.js';

/**
 * While `running`, calls `onTick` a few times per stale window so a build that
 * stopped saving is noticed without any other state change.
 * @param {boolean} running
 * @param {() => void} onTick
 */
export function useStaleTick(running, onTick) {
  useEffect(() => {
    if (!running) return undefined;
    const timer = setInterval(onTick, SUMMARY_TREE_STALE_MS / 4);
    return () => clearInterval(timer);
  }, [running, onTick]);
}
