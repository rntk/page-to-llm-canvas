import { createRoot } from 'react-dom/client';
import { createRailSurfaceManager } from '../rails/shared/surface.js';
import { createInPageRailController } from '../rails/in-page/controller.jsx';
import * as preferences from '../shared/surfacePreferences.js';

export async function createInPageRailSurface({
  document,
  runtimeMessenger,
  dialogs,
  openRecordFrame,
  onDestroy,
}) {
  await preferences.init();
  const manager = createRailSurfaceManager({ document, rootFactory: createRoot, preferences });
  const controller = createInPageRailController({
    surfaceManager: manager,
    openRecordFrame,
    document,
    window: document.defaultView,
    runtimeMessenger,
    dialogs,
    onDestroy,
  });
  return { open: controller.openInPageRail, close: manager.close, destroy: manager.dispose };
}
