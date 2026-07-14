// Shared runtime-message type constants. Kept at the repo root (like theme.js)
// so it is importable both by the bundled src/ code (Vite inlines it) and by the
// unbundled background.js service worker (which loads it as a plain ES module
// from dist/ via a relative path). The build copies this file into dist/.
//
// These are the `type` values on chrome.runtime messages dispatched by
// background.js's MESSAGE_HANDLERS. The content-script `action:` messages
// ('startSelection', 'openRecordView') are a separate namespace and intentionally
// not included here.
export const MSG = Object.freeze({
  submit: 'submit',
  ensurePipeline: 'ensurePipeline',
  retryRecord: 'retryRecord',
  reprocessRecord: 'reprocessRecord',
  generateRecordSummaries: 'generateRecordSummaries',
  cancelRecordProcessing: 'cancelRecordProcessing',
  resolveSummaryErrors: 'resolveSummaryErrors',
  getRecord: 'getRecord',
  listRecords: 'listRecords',
  importRecords: 'importRecords',
  deleteRecord: 'deleteRecord',
  deleteAll: 'deleteAll',
  llmChatCompletion: 'llmChatCompletion',
  listChats: 'listChats',
  getChat: 'getChat',
  appendChatTurn: 'appendChatTurn',
  deleteChatEvent: 'deleteChatEvent',
  deleteChat: 'deleteChat',
  listProviders: 'listProviders',
  saveProvider: 'saveProvider',
  deleteProvider: 'deleteProvider',
  setActiveProvider: 'setActiveProvider',
});
