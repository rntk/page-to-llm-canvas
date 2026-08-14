import { MSG } from '../../../shared/runtime/messages.js';

/**
 * Handlers for whole-extension data operations. Deliberately its own group:
 * the full reset spans the pipeline registry, the chat request registry, every
 * metrics queue and authoritative storage, so folding it into any single
 * capability bucket would re-couple those capabilities to each other.
 *
 * @param {object} deps
 * @param {{activeJobPromises: Function, cancelAll: Function}} deps.pipelineSupervisor
 * @param {{cancelAll: Function, activeCompletionJobs: Function}} deps.chatService
 * @param {Function} deps.getStorageOverview
 * @param {Function} deps.clearAllExtensionData
 * @param {Function[]} deps.metricsClears Every metrics queue drained before the reset.
 */
export function createDataManagementHandlers({
  pipelineSupervisor,
  chatService,
  getStorageOverview,
  clearAllExtensionData,
  metricsClears,
}) {
  return {
    [MSG.getStorageOverview]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        return { ok: true, overview: await getStorageOverview() };
      },
    },

    [MSG.deleteAllExtensionData]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        const pipelineJobs = pipelineSupervisor.activeJobPromises();
        pipelineSupervisor.cancelAll();
        chatService.cancelAll();
        // Snapshot after the aborts, matching the original inline spread: an
        // abort is synchronous, so a cancelled job is still in this set and
        // must be awaited to reach its terminal write.
        const completionJobs = chatService.activeCompletionJobs();

        // Let cancelled work reach its terminal metric/log writes, then drain
        // each metrics queue before the authoritative storage clear. This keeps
        // an old request from restoring data immediately after reset returns.
        await Promise.allSettled([...pipelineJobs, ...completionJobs]);
        // Metric clears are queued after the cancelled work's terminal writes.
        // Let every queue settle even when a best-effort preliminary clear
        // fails, then perform the authoritative full reset. Otherwise one
        // failed metric write would leave all extension data in place.
        await Promise.allSettled(metricsClears.map((clear) => clear()));
        await clearAllExtensionData();
        return { ok: true };
      },
    },
  };
}
