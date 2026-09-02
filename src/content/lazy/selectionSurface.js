import { createRoot } from 'react-dom/client';
import { createSelectionController } from '../selection/controller.jsx';
import * as preferences from '../shared/surfacePreferences.js';

export async function createSelectionSurface({ document, runtimeMessenger, dialogs, onDestroy }) {
  await preferences.init(document);
  return createSelectionController({
    document,
    window: document.defaultView,
    rootFactory: createRoot,
    preferences,
    runtimeMessenger,
    dialogs,
    onDestroy,
  });
}
