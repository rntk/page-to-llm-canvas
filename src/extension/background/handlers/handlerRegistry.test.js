// Pins the shape of the merged message-handler registry.
//
// Like pipelineSupervisor.test.js, this file installs no `chrome` global and
// mocks no worker module: every handler group is built from plain stubs. That
// is the property the split exists for — constructing the worker's behavior
// must not touch the browser.
//
// It also guards the one failure mode the spread-merge in background.js cannot
// report: a key defined in two groups is silently won by the later spread, with
// no error and nothing for lint to catch.
import { describe, it, expect, vi } from 'vitest';
import { MSG } from '../../../shared/runtime/messages.js';
import { createRecordHandlers } from './recordHandlers.js';
import { createChatHandlers } from './chatHandlers.js';
import { createMetricsHandlers } from './metricsHandlers.js';
import { createProviderHandlers } from './providerHandlers.js';
import { createDataManagementHandlers } from './dataManagementHandlers.js';

const stubSupervisor = () => ({
  startPipeline: vi.fn(async () => {}),
  cancelActivePipeline: vi.fn(() => false),
  createPipelineRunId: vi.fn(() => 'run-1'),
  isActive: vi.fn(() => false),
  activeJobPromises: vi.fn(() => []),
  cancelAll: vi.fn(),
  getPipelineFailures: vi.fn(async () => ({ failures: {}, unavailable: false })),
  clearPipelineFailuresForKey: vi.fn(async () => {}),
});

const stubChatService = () => ({
  complete: vi.fn(async () => ({ ok: true })),
  cancelTurn: vi.fn(),
  cancelAll: vi.fn(),
  activeCompletionJobs: vi.fn(() => []),
});

/** Builds every group from stubs, keyed by group name. */
function buildGroups() {
  return {
    record: createRecordHandlers({
      recordRepository: {
        readRecord: vi.fn(),
        updateRecord: vi.fn(),
        listRecords: vi.fn(),
        writeRecord: vi.fn(),
        deleteRecord: vi.fn(),
        deleteAll: vi.fn(),
      },
      handleSubmit: vi.fn(),
      pipelineSupervisor: stubSupervisor(),
      getStoredSummariesDisabled: vi.fn(async () => false),
      summaryCheckpoint: { isComplete: vi.fn(() => true), isRevisionCurrent: vi.fn(() => true) },
    }),
    chat: createChatHandlers({
      chatRepository: {
        listChats: vi.fn(),
        readChat: vi.fn(),
        appendChatTurn: vi.fn(),
        deleteChatHistory: vi.fn(),
      },
      chatService: stubChatService(),
      providerRepository: { getActiveProvider: vi.fn(async () => null) },
    }),
    metrics: createMetricsHandlers({
      recordChatToolMetric: vi.fn(),
      clearChatToolMetrics: vi.fn(),
      clearParserMetrics: vi.fn(),
      clearResplitMetrics: vi.fn(),
    }),
    provider: createProviderHandlers({
      getProvidersState: vi.fn(),
      saveProvider: vi.fn(),
      deleteProvider: vi.fn(),
      setActiveProvider: vi.fn(),
      sanitizeProvider: vi.fn(),
      sanitizeProvidersState: vi.fn(),
    }),
    dataManagement: createDataManagementHandlers({
      pipelineSupervisor: stubSupervisor(),
      chatService: stubChatService(),
      getStorageOverview: vi.fn(),
      clearAllExtensionData: vi.fn(),
      metricsClears: [],
    }),
  };
}

describe('message handler registry (no chrome global)', () => {
  it('builds every handler group without a browser', () => {
    expect(globalThis.chrome).toBeUndefined();
    expect(() => buildGroups()).not.toThrow();
    expect(globalThis.chrome).toBeUndefined();
  });

  it('defines no message type in more than one group', () => {
    const groups = Object.entries(buildGroups());
    const owners = new Map();
    const collisions = [];
    for (const [name, handlers] of groups) {
      for (const type of Object.keys(handlers)) {
        if (owners.has(type)) collisions.push(`${type}: ${owners.get(type)} and ${name}`);
        owners.set(type, name);
      }
    }
    expect(collisions).toEqual([]);
  });

  it('merges to exactly the expected message types', () => {
    const groups = buildGroups();
    const merged = {
      ...groups.record,
      ...groups.chat,
      ...groups.metrics,
      ...groups.provider,
      ...groups.dataManagement,
    };

    expect(Object.keys(merged).sort()).toEqual(
      [
        MSG.submit,
        MSG.retryRecord,
        MSG.reprocessRecord,
        MSG.generateRecordSummaries,
        MSG.cancelRecordProcessing,
        MSG.resolveSummaryErrors,
        MSG.getRecord,
        MSG.getRecordView,
        MSG.listRecords,
        MSG.importRecords,
        MSG.deleteRecord,
        MSG.deleteAll,
        MSG.getArticleChatLimits,
        MSG.llmChatCompletion,
        MSG.cancelChatTurn,
        MSG.listChats,
        MSG.getChat,
        MSG.appendChatTurn,
        MSG.deleteChat,
        MSG.recordChatToolMetric,
        MSG.clearChatToolMetrics,
        MSG.clearParserMetrics,
        MSG.clearResplitMetrics,
        MSG.listProviders,
        MSG.saveProvider,
        MSG.deleteProvider,
        MSG.setActiveProvider,
        MSG.getStorageOverview,
        MSG.deleteAllExtensionData,
      ].sort(),
    );
    // No group may lose an entry to a later spread.
    const groupTotal = Object.values(groups).reduce(
      (sum, handlers) => sum + Object.keys(handlers).length,
      0,
    );
    expect(Object.keys(merged)).toHaveLength(groupTotal);
  });

  it('gives every handler the full entry shape dispatch relies on', () => {
    const groups = buildGroups();
    for (const [name, handlers] of Object.entries(groups)) {
      for (const [type, entry] of Object.entries(handlers)) {
        expect(typeof entry.requiresExtensionPage, `${name}.${type}`).toBe('boolean');
        expect(typeof entry.validate, `${name}.${type}`).toBe('function');
        expect(typeof entry.handle, `${name}.${type}`).toBe('function');
      }
    }
  });

  it('keeps every provider and data-management action extension-page only', () => {
    const groups = buildGroups();
    for (const handlers of [groups.provider, groups.dataManagement]) {
      for (const [type, entry] of Object.entries(handlers)) {
        expect(entry.requiresExtensionPage, type).toBe(true);
      }
    }
    for (const type of [
      MSG.importRecords,
      MSG.getRecord,
      MSG.listRecords,
      MSG.deleteRecord,
      MSG.deleteAll,
    ]) {
      expect(groups.record[type].requiresExtensionPage, type).toBe(true);
    }
    for (const type of [
      MSG.clearParserMetrics,
      MSG.clearResplitMetrics,
      MSG.clearChatToolMetrics,
    ]) {
      expect(groups.metrics[type].requiresExtensionPage, type).toBe(true);
    }
    expect(groups.record[MSG.getRecordView].requiresExtensionPage).toBe(false);
    expect(groups.metrics[MSG.recordChatToolMetric].requiresExtensionPage).toBe(false);
    expect(groups.record[MSG.submit].requiresExtensionPage).toBe(false);
  });
});
