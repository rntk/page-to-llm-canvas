import { createRoot } from 'react-dom/client';
import { createRailSurfaceManager } from '../rails/shared/surface.js';
import { createYouTubeRailController } from '../rails/youtube/controller.jsx';
import * as preferences from '../shared/surfacePreferences.js';

export async function createYouTubeRailSurface({ document, runtimeMessenger, dialogs, onDestroy }) {
  await preferences.init();
  const manager = createRailSurfaceManager({ document, rootFactory: createRoot, preferences });
  const controller = createYouTubeRailController({
    surfaceManager: manager,
    document,
    runtimeMessenger,
    dialogs,
    onDestroy,
  });
  return { open: controller.openYouTubeRail, close: manager.close, destroy: manager.dispose };
}
