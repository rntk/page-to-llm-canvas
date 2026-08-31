// Shared runtime-message type constants for extension surfaces and the service
// worker. Keep this file dependency-free and browser-safe.
//
// These are the `type` values on chrome.runtime messages dispatched by
// background.js's MESSAGE_HANDLERS. The content-script `action:` messages
// ('startSelection', 'openRecordView') are a separate namespace and intentionally
// not included here.
export const MSG = Object.freeze({
  submit: 'submit',
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
  getStorageOverview: 'getStorageOverview',
  deleteAllExtensionData: 'deleteAllExtensionData',
  getArticleChatLimits: 'getArticleChatLimits',
  llmChatCompletion: 'llmChatCompletion',
  cancelChatTurn: 'cancelChatTurn',
  recordChatToolMetric: 'recordChatToolMetric',
  clearChatToolMetrics: 'clearChatToolMetrics',
  clearParserMetrics: 'clearParserMetrics',
  clearResplitMetrics: 'clearResplitMetrics',
  listChats: 'listChats',
  getChat: 'getChat',
  appendChatTurn: 'appendChatTurn',
  deleteChat: 'deleteChat',
  listProviders: 'listProviders',
  saveProvider: 'saveProvider',
  deleteProvider: 'deleteProvider',
  setActiveProvider: 'setActiveProvider',
});
