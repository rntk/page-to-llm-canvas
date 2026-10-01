import { MSG } from '../../../shared/runtime/messages.js';

/**
 * Whole-extension data handlers. Reset spans active jobs, metrics queues, and storage.
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
        // Snapshot after aborts; cancelled jobs still need to finish terminal writes.
        const completionJobs = chatService.activeCompletionJobs();

        // Drain cancelled work and metrics before clearing storage so old writes
        // cannot restore data after reset.
        await Promise.allSettled([...pipelineJobs, ...completionJobs]);
        // A failed preliminary metric clear must not prevent the full reset.
        await Promise.allSettled(metricsClears.map((clear) => clear()));
        await clearAllExtensionData();
        return { ok: true };
      },
    },
  };
}
