import { MSG } from '../../../shared/runtime/messages.js';

/**
 * Handlers for provider settings. All of them are extension-page only: the
 * sanitized state still describes which providers are configured.
 *
 * @param {object} deps
 * @param {Function} deps.getProvidersState
 * @param {Function} deps.saveProvider
 * @param {Function} deps.deleteProvider
 * @param {Function} deps.setActiveProvider
 * @param {Function} deps.sanitizeProvider
 * @param {Function} deps.sanitizeProvidersState
 */
export function createProviderHandlers({
  getProvidersState,
  saveProvider,
  deleteProvider,
  setActiveProvider,
  sanitizeProvider,
  sanitizeProvidersState,
}) {
  const requireId = (msg) => (msg.id ? null : 'missing id');

  return {
    [MSG.listProviders]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle() {
        const state = await getProvidersState();
        return { ok: true, ...sanitizeProvidersState(state) };
      },
    },

    [MSG.saveProvider]: {
      requiresExtensionPage: true,
      validate: () => null,
      async handle(msg) {
        const provider = await saveProvider(msg.provider);
        const state = await getProvidersState();
        return { ok: true, provider: sanitizeProvider(provider), ...sanitizeProvidersState(state) };
      },
    },

    [MSG.deleteProvider]: {
      requiresExtensionPage: true,
      validate: requireId,
      async handle(msg) {
        const state = await deleteProvider(msg.id);
        return { ok: true, ...sanitizeProvidersState(state) };
      },
    },

    [MSG.setActiveProvider]: {
      requiresExtensionPage: true,
      validate: requireId,
      async handle(msg) {
        const state = await setActiveProvider(msg.id);
        return { ok: true, ...sanitizeProvidersState(state) };
      },
    },
  };
}
