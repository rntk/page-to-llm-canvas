import { createRecordFrameManager } from '../record-view/iframeManager.js';

export function createRecordFrameSurface({ document, runtimeMessenger }) {
  return createRecordFrameManager({ document, getRuntimeUrl: runtimeMessenger.getURL });
}
